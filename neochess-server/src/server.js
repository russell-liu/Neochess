/* Environment variables */
require('dotenv').config()

/* External dependencies */
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const {MongoClient, ObjectId} = require('mongodb');
const _ = require('lodash');
const chessjs = require('chess.js');

/* Internal dependencies */
const log = require('./tools/log');
const utils = require('./tools/utils');

/* Configure logger */
const logger = log.logger('Server');

/* Configure express and socket.io */
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
io.origins(process.env.NEOCHESS_WEB_URL);

/* Configure cors */
app.use(cors());

/* Get JSON body from requests */
app.use(express.json());

/* Configure routes */
const routes = require('./routes');
app.use(routes);

/* Get port from .env */
const port = process.env.NEOCHESS_SERVER_PORT;

/* MongoDB instance */
const mongo = new MongoClient(process.env.NEOCHESS_DB_URI, {
	useUnifiedTopology: true
});

/* Connect to MongoDB */
let gameCollection;
mongo.connect().then(() => {
	gameCollection = mongo.db(process.env.NEOCHESS_DB).collection('games');
	logger.log({
		level: 'info',
		message: `Connected to MongoDB Cloud`
	});
});

/* Server constants */
const TIMESYNC_TIMEOUT = 180000;

/* Server memory
**
** users: maps a socket id to a username
** sockets: maps a username to a socket id
** timers: holds a timer for each pair (username, game id)
** timesync: holds a time sync schedule for each game
** currentGameId: maps a username to his current game
** joinableGames: holds an array of games still waiting for an opponent to join
*/

let users = {};
let sockets = {};
let timers = {};
let timesync = {};
let currentGameId = {};
let joinableGames = [];
let watchableGames = [];
let playerReceivedLastmove = {};
let lastMoveFromGame = {};

/* Available time controls */
const seconds = {
	'1+0': 60,
	'3+0': 60*3,
	'5+0': 60*5,
	'10+0': 60*10,
	'15+0': 60*15,
	'30+0': 60*30,
}

/**
 * Emits the gameOver event to a game room and clears corresponding timers.
 * @param {String} gameId Id from the game that just finished.
 * @param {String} player1 Username of the first player.
 * @param {String} player2 Username of the second player.
 * @param {Object} resultData Object containing {result, winner}.
 */
const gameOver = async (gameId, player1, player2, resultData) => {
	/* Checks if game is not yet set as finished in the DB */
	let game = await getGame(gameId);
	const whiteUsername = game.players.white.username;
	const blackUsername = game.players.black.username;
	const tWhite = Math.max(0, timers[whiteUsername+gameId].time);
	const tBlack = Math.max(0, timers[blackUsername+gameId].time);
	if (!game.state.finished) {
		/* Emits gameOver event to the game room */
		io.to(gameId).emit('gameOver', resultData);
		/* Stops time counting for both players */
		if (player1 && timers[player1+gameId].loop) {
			clearInterval(timers[player1+gameId].loop);
			timers[player1+gameId].loop = null;
		}
		if (player2 && timers[player2+gameId].loop) {
			clearInterval(timers[player2+gameId].loop);
			timers[player2+gameId].loop = null;
		}
		/* Stops time sync for the game room */
		if (timesync[gameId]) {
			clearInterval(timesync[gameId].mainLoop);
			clearInterval(timesync[gameId].ackLoop);
			timesync[gameId] = null;
		}
		/* Game is set as finished */
		game = await updateGame(gameId, {
			'state.finished': true,
			'result.description': resultData.result,
			'result.winner': resultData.winner,
			'players.white.time': tWhite,
			'players.black.time': tBlack
		});
		/* Removes the game from array of joinable and watchable games */
		joinableGames = joinableGames.filter(g => g.gameId.toString() != gameId);
		watchableGames = watchableGames.filter(g => g.gameId.toString() != gameId);
		/* Broadcasts the updated list of joinable games, filtered by username */
		for (let u in sockets) {
			const socketId = sockets[u];
			io.to(socketId).emit('gamesList', {
				games: joinableGames.filter(g => g.host !== u),
				watchableGames: watchableGames.filter(g => g.host !== u)
			});
		}
		io.to(gameId).emit('updateGame', {game});
	}
}

const gameTimeSync = (gameId, whiteUsername, blackUsername) => {
	let sync = {};
	sync.gameId = gameId;
	sync[whiteUsername] = Math.max(0, timers[whiteUsername+gameId].time);
	sync[blackUsername] = Math.max(0, timers[blackUsername+gameId].time);
	io.to(gameId).emit('timesync', sync);
}

const userTimeSync = (username, whiteUsername, blackUsername) => {
	let sync = {};
	const gameId = currentGameId[username];
	sync.gameId = gameId;
	sync[whiteUsername] = Math.max(0, timers[whiteUsername+gameId].time);
	sync[blackUsername] = Math.max(0, timers[blackUsername+gameId].time);
	io.to(username+sockets[username]+gameId).emit('timesync', sync);
}

const createGame = async (game) => {
	const result = await gameCollection.insertOne(game);
	return {...game, ...{_id: result.insertedId}};
}

const getGame = async (gameId) => {
	return await gameCollection.findOne({_id: new ObjectId(gameId)});
}

const updateGame = async (gameId, update) => {
	const result = await gameCollection.findOneAndUpdate(
		{_id: new ObjectId(gameId)},
		{$set: update},
		{returnOriginal: false}
	);
	return result.value;
}

/**
 * Socket.io event handling
 * 
 */

io.on('connection', (socket) => {

	socket.on('username', async (data) => {

		try {

			if (!data.username) {

				/* Generates username */
				const username = utils.random_username();
	
				/* Username is emitted back */
				socket.emit('username', {username});
	
				/* Saves user in memory */
				users[socket.id] = username;
				sockets[username] = socket.id;
	
				/* Event is logged */
				logger.log({
					level: 'info',
					message: `User connected: ${username}`
				});
	
			} else {
	
				/* Sets username */
				const username = data.username;
	
				/* Updates user in memory */
				users[socket.id] = username;
				sockets[username] = socket.id;

				/* If user was connected to a game before... */
				if (currentGameId[username]) {

					/* Reconnects the user to the game */
					const gameId = currentGameId[username];
					socket.join(gameId);
					socket.join(username+socket.id+gameId);

					const game = await getGame(gameId);

					/* If game was finished while user was offline... */
					if (game.state.finished) {
						/* Emits gameOver event to the user */
						const resultData = {
							result: game.result.description,
							winner: game.result.winner
						};
						io.to(username+socket.id+gameId).emit('gameOver', resultData);
						/* Emits the last state of the timers */
						const whiteUsername = game.players.white.username;
						const blackUsername = game.players.black.username;
						userTimeSync(username, whiteUsername, blackUsername);
					}

					if (!playerReceivedLastmove[username+gameId]) {

						/* Gets user room */
						const userRoom = username+sockets[username]+gameId;

						/* Emits move to the user */
						io.to(userRoom).emit('moved', lastMoveFromGame[gameId]);

						/* Emits updateGame event to the user */
						io.to(userRoom).emit('updateGame', {
							game
						});
					}
				}
	
				/* Event is logged */
				logger.log({
					level: 'info',
					message: `User reconnected: ${username}`
				});
			}

		} catch (error) {

			console.log(error);
		}
	});

	socket.on('disconnect', (reason) => {

		try {

			/* Gets username based on socket id */
			const username = users[socket.id];

			/* Removes user from memory */
			delete users[socket.id];
			delete sockets[username];

			/* User leaves all rooms */
			socket.leaveAll();

			/* Event is logged */
			logger.log({
				level: 'info',
				message: `User disconnected: ${username}`
			});

		} catch (error) {

			console.log(error);
		}
	});

	socket.on('getGames', async () => {

		try {

			const username = users[socket.id];
			socket.emit('gamesList', {
				games: joinableGames.filter(g => g.host !== username),
				watchableGames: watchableGames.filter(g => g.host !== username)
			});

		} catch (error) {

			console.log(error);
		}

	});

	socket.on('newGame', async (data) => {

		try {

			/* Defines a game */
			const random = Math.random();
			const orientation = random < 0.5 ? 'white' : 'black';
			const username = users[socket.id];

			let game = {
				host: username,
				guest: null,
				players: {
					white: {
						username: orientation === 'white' ? username : null,
						time: seconds[data.timeControl]
					},
					black: {
						username: orientation === 'black' ? username : null,
						time: seconds[data.timeControl]
					}
				},
				timeControl: {
					minutes: parseInt(data.timeControl.split('+')[0]),
					increment: parseInt(data.timeControl.split('+')[1]),
					string: data.timeControl
				},
				state: {
					fen: new chessjs.Chess().fen(),
					joinable: true,
					started: false,
					finished: false,
					lastMove: null
				},
				history: {
					pgn: new chessjs.Chess().pgn(),
					moves: new chessjs.Chess().history()
				},
				result: {
					description: null,
					winner: null
				}
			}

			/* Creates a game */
			game = await createGame(game);
			const gameId = game._id;

			/* User leaves previous game */
			const previousGameId = currentGameId[username];
			if (previousGameId) {
				socket.leave(previousGameId);
				socket.leave(username+sockets[username]+previousGameId);
			}

			/* User joins the new game room */
			socket.join(gameId);
			socket.join(username+socket.id+gameId);
			currentGameId[username] = gameId;

			/* Game parameters are emitted to the user */
			io.to(gameId).emit('gameCreated', {game});

			/* A timer is assigned to the user for this game */
			timers[username+gameId] = {
				loop: null,
				time: seconds[game.timeControl.string]
			};

			/* Starts emitting timesync events */
			let lastTimeSync = {};
			lastTimeSync[username] = new Date();
			timesync[gameId] = {
				mainLoop: setInterval(() => {
					let sync = {};
					sync.gameId = gameId;
					sync[username] = Math.max(0, timers[username+gameId].time);
					socket.emit('timesync', sync);
				}, 500),
				lastTimeSync,
				ackLoop: setInterval(async () => {
					if (timesync[gameId]) {
						const now = new Date();
						const lastTimeSync = timesync[gameId].lastTimeSync[username];
						if (Math.abs(now.getTime() - lastTimeSync.getTime()) > TIMESYNC_TIMEOUT) {
							/* Host has disconnected from the game */
							logger.log({
								level: 'info',
								message: `${username} disconnected from the game ${gameId}`
							});
							/* Removes the game from array of joinable games */
							joinableGames = joinableGames.filter(g => g.gameId.toString() != gameId);
							watchableGames = watchableGames.filter(g => g.gameId.toString() != gameId);
							/* Broadcasts the updated list of joinable games, filtered by username */
							for (let u in sockets) {
								const socketId = sockets[u];
								io.to(socketId).emit('gamesList', {
									games: joinableGames.filter(g => g.host !== u),
									watchableGames: watchableGames.filter(g => g.host !== u)
								});
							}
							/* Terminates the game */
							const resultData = {result: 'abandonment', winner: null};
							await gameOver(gameId, null, null, resultData);
						}
					}
				}, TIMESYNC_TIMEOUT),
			};

			/* Removes other games from this user from joinable list */
			joinableGames = joinableGames.filter(g => g.host !== username);

			/* Set game as joinable */
			joinableGames.push({
				host: username,
				timeControl: game.timeControl.string,
				gameId: gameId},
			);

			/* Broadcasts the updated list of joinable games, filtered by username */
			for (let u in sockets) {
				const socketId = sockets[u];
				io.to(socketId).emit('gamesList', {
					games: joinableGames.filter(g => g.host !== u),
					watchableGames: watchableGames.filter(g => g.host !== u)
				});
			}

			/* Event is logged */
			const loginfo = {
				gameId,
				host: game.host, 
				timeControl: game.timeControl.string
			};
			logger.log({
				level: 'info',
				message: `Game created ${log.dict2log(loginfo)}`
			});

			/* Just to be safe, returns */
			return;

		} catch (error) {

			/* Logs the error, emits the error */
			console.log(error);
			socket.emit('gameCreated', {
				error: {
					code: 'INTERNAL_SERVER_ERROR',
					message: 'internal server error'
				}
			});

			return;

		}
	});

	socket.on('joinGame', async (data) => {

		try {

			/* Gets id from the game to be joined */
			const { gameId } = data;

			/* Gets username */
			const username = users[socket.id];

			/* Searches for the game using gameId */
			let game = await getGame(gameId);

			let watcher = false;
			if (!game.state.joinable || game.state.finished || game.host === username) {
				watcher = true;
			}

			/* Defines new player orientation and opponent */
			let orientation;
			if (watcher) orientation = 'white'
			else orientation = game.players.white.username ? 'black' : 'white';

			/**
			 * Generates info to update the game in the database
			 * Also defines opponent
			 */
			
			if (!watcher) {

				let update;
				let opponent;

				if (orientation === 'white') {
					update = {'players.white.username': username};
					opponent = game.players.black.username;
				} 
				else if (orientation === 'black') {
					update = {'players.black.username': username};
					opponent = game.players.white.username;
				}
				update['guest'] = username;
				update['state.joinable'] = false;
	
				/* Updates the game in the database */
				game = await updateGame(gameId, update);

				/* Emits update game event to opponent */
				io.to(opponent+sockets[opponent]+gameId).emit('updateGame', {game});

				/* A timer is assigned to the joining user for this game */
				timers[username+gameId] = {
					loop: null,
					time: seconds[game.timeControl.string]
				};

				const whiteUsername = game.players.white.username;
				const blackUsername = game.players.black.username;

				/* Updates time sync for the game room */
				if (timesync[gameId]) {
					clearInterval(timesync[gameId].mainLoop);
					clearInterval(timesync[gameId].ackLoop);
				}
				let lastTimeSync = timesync[gameId].lastTimeSync;
				lastTimeSync[username] = new Date();

				timesync[gameId] = {
					mainLoop: setInterval(() => {
						gameTimeSync(gameId, whiteUsername, blackUsername);
					}, 500),
					lastTimeSync,
					ackLoop: setInterval(async () => {
						const now = new Date();
						const lastTimeSyncW = timesync[gameId].lastTimeSync[whiteUsername];
						const lastTimeSyncB = timesync[gameId].lastTimeSync[blackUsername];
						if (Math.abs(now.getTime() - lastTimeSyncW.getTime()) > TIMESYNC_TIMEOUT) {
							/* White has disconnected from the game */
							logger.log({
								level: 'info',
								message: `${whiteUsername} disconnected from the game ${gameId}`
							});
							const resultData = {result: 'abandonment', winner: blackUsername};
							await gameOver(gameId, whiteUsername, blackUsername, resultData);
						}
						if (Math.abs(now.getTime() - lastTimeSyncB.getTime()) > TIMESYNC_TIMEOUT) {
							/* Black has disconnected from the game */
							logger.log({
								level: 'info',
								message: `${blackUsername} disconnected from the game ${gameId}`
							});
							const resultData = {result: 'abandonment', winner: whiteUsername};
							await gameOver(gameId, whiteUsername, blackUsername, resultData);
						}
					}, TIMESYNC_TIMEOUT),
				};
			}

			/* User leaves previous game */
			const previousGameId = currentGameId[username];
			if (previousGameId) {
				socket.leave(previousGameId);
				socket.leave(username+sockets[username]+previousGameId);
			}

			/* User joins the game room */
			socket.join(gameId);
			socket.join(username+socket.id+gameId);
			currentGameId[username] = gameId;

			/* Game parameters are emitted to the user */
			io.to(socket.id).emit('gameJoined', {game, watcher});

			/* If game is joined, removes it from array of joinable games */
			joinableGames = joinableGames.filter(g => g.gameId.toString() != gameId);

			/* Set game as watchable */
			const alreadyWatchable = watchableGames.find(g => g.gameId === gameId);
			if (!alreadyWatchable && !game.state.finished) {
				const white = game.players.white.username;
				const black = game.players.black.username
				watchableGames.push({
					host: `${white} vs ${black}`,
					timeControl: game.timeControl.string,
					gameId: gameId},
				);
			}

			/* If game was finished... */
			if (game.state.finished) {
				/* Emits gameOver event */
				const resultData = {
					result: game.result.description,
					winner: game.result.winner
				};
				io.to(username+socket.id+gameId).emit('gameOver', resultData);
				/* Emits the last state of the timers */
				const whiteUsername = game.players.white.username;
				const blackUsername = game.players.black.username;
				let sync = {};
				sync.gameId = gameId;
				if ('time' in game.players.white)
					sync[whiteUsername] = game.players.white.time;
				else sync[whiteUsername] = seconds[game.timeControl.string];
				if ('time' in game.players.black)
					sync[blackUsername] = game.players.black.time;
				else sync[blackUsername] = seconds[game.timeControl.string];
				io.to(username+sockets[username]+gameId).emit('timesync', sync);
			}

			/* Broadcasts the updated list of joinable games, filtered by username */
			for (let u in sockets) {
				const socketId = sockets[u];
				io.to(socketId).emit('gamesList', {
					games: joinableGames.filter(g => g.host !== u),
					watchableGames: watchableGames.filter(g => g.host !== u)
				});
			}

			/* Event is logged */
			const loginfo = {
				gameId,
				host: game.host, guest: game.guest,
				timeControl: game.timeControl.string
			};
			logger.log({
				level: 'info',
				message: `Game joined ${log.dict2log(loginfo)}`
			});

			return;

		} catch (error) {

			/* Logs the error, emits the error */
			console.log(error);
			socket.emit('gameJoined', {
				error: {
					code: 'INTERNAL_SERVER_ERROR',
					message: 'internal server error'
				}
			});

			return;

		}
	});

	socket.on('move', async (movedata) => {

		try {

			/* Gets gameId, fen and move from movedata*/
			const { username, gameId, fen, move } = movedata;

			let game = await getGame(gameId);

			if (game.state.finished) return;

			/* Generates a game representation */
			let gameRepresentation = new chessjs.Chess();
			gameRepresentation.load_pgn(game.history.pgn);
			gameRepresentation.move(move);

			/* Updates the game */
			const update = {
				'state.fen': gameRepresentation.fen(),
				'state.lastMove': move,
				'history.pgn': gameRepresentation.pgn(),
				'history.moves': gameRepresentation.history({verbose: true})
			};
			game = await updateGame(gameId, update);

			/* Logs the event */
			const logdata = { username, gameId, move };
			logger.log({
				level: 'info',
				message: `New move ${log.dict2log(logdata)}`
			});

			/* TODO: The following could be improved. I believe only one event needs to
			** be emitted. Keeping this way for now to avoid breaking other functions */

			const blackUsername = game.players.black.username;
			const whiteUsername = game.players.white.username;
			const opponent = username === whiteUsername ? blackUsername : whiteUsername;
			const orientation = username === whiteUsername ? 'white' : 'black';

			/* Save last move from game */
			lastMoveFromGame[gameId] = movedata;
			playerReceivedLastmove[blackUsername+gameId] = false;
			playerReceivedLastmove[whiteUsername+gameId] = false;

			/* Emits move to the game room */
			io.to(gameId).emit('moved', movedata);

			/* Stops the player's timer */
			if (timers[username+gameId].loop) {
				clearInterval(timers[username+gameId].loop);
				timers[username+gameId].loop = null;
			}

			/* Starts timers only after black plays its first move */
			if (orientation === 'black' || game.state.started) {
				/* Starts opponent's timer */
				/**
				 * TODO: HOW TO AVOID DECREASING TIMER IF GAME HAS FINISHED?
				 * Sometimes, if a move is passed by a player whose timer just reached 0,
				 * the game ends by timeout, but it still keeps decreasing opponent's
				 * timer. When this timer reaches 0 too, server emits an event
				 * stating that the opponent lost by timeout, which is not true.
				 * Check this out later. Couldn't reproduce this bug consistently yet.
				 */

				timers[opponent+gameId] = {
					loop: setInterval(async () => {
						const t = timers[opponent+gameId].time;
						timers[opponent+gameId].time = Math.max(-1, t - 1);
						if(timers[opponent+gameId].time <= -1) {
							/* TODO: draw if player has insufficient material
							** For now, if the time is over, the other player wins...
							*/
							const resultData = {
								result: 'ontime',
								winner: username
							};
							await gameOver(gameId, username, opponent, resultData);
						};
					}, 1000),
					time: timers[opponent+gameId].time
				};
				/* Game is set as started only after black plays */
				game = await updateGame(gameId, {'state.started': true});
			}

			/* Logs the game is ascii */
			console.log(gameRepresentation.ascii());

			/* Detects if the game is over and determines the result */
			if (gameRepresentation.game_over()) {

				let result;
				let winner = null;

				if (gameRepresentation.in_checkmate()) {

					result = 'checkmate';
					winner = username

				} else {

					if (gameRepresentation.in_draw()) {
						if (gameRepresentation.in_stalemate())
							result = 'draw.stalemate';
						else if (gameRepresentation.in_threefold_repetition())
							result = 'draw.threefold_repetition';
						else if (gameRepresentation.insufficient_material())
							result = 'draw.insufficient_material';
					}
				}

				const resultData = {result, winner};
				await gameOver(gameId, username, opponent, resultData);
				/* TODO: Change resultData schema */

			} else {

				/* Emits updateGame event to black */
				io.to(blackUsername+sockets[blackUsername]+gameId).emit('updateGame', {
					game
				});

				/* Emits updateGame event to white */
				io.to(whiteUsername+sockets[whiteUsername]+gameId).emit('updateGame', {
					game
				});
			}

			return;

		} catch (error) {

			/* Logs the error */
			console.log(error);

		}
	});

	socket.on('resign', async (data) => {

		try {

			const username = users[socket.id];
			const gameId = currentGameId[username];

			let game = await getGame(gameId);

			const white = game.players.white.username;
			const black = game.players.black.username;
			if (username === white || username === black) {

				if (game.state.finished) return;

				const result = 'resignation';
				const winner = username === game.players.white.username ? 
					game.players.black.username : game.players.white.username;

				const resultData = {result, winner};
				await gameOver(gameId, username, winner, resultData);

				return;

			} else return;

		} catch (error) {

			/* Logs the error */
			console.log(error);

		}
	});

	socket.on('syncAck', async (ack) => {

		try {

			const username = users[socket.id];
			const gameId = currentGameId[username];

			if (timesync[gameId])
				timesync[gameId].lastTimeSync[username] = new Date();

			return;

		} catch (error) {

			/* Logs the error */
			console.log(error);

		}
	});

	socket.on('moveAck', async (ack) => {

		try {

			const username = users[socket.id];
			const gameId = currentGameId[username];

			playerReceivedLastmove[username+gameId] = true;

			return;

		} catch (error) {

			/* Logs the error */
			console.log(error);

		}
	});

	socket.on('updatedShapes', async (data) => {

		try {

			const username = data.username;
			const gameId = data.gameId;

			io.to(gameId).emit('syncShapes', data);

			return;

		} catch (error) {

			/* Logs the error */
			console.log(error);

		}
	});

});

/* Starts the server */
server.listen(port, () => {
	logger.log({
		level: 'info',
		message: `Online at port ${port}`
	});
});
