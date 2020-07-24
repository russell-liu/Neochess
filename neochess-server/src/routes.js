const express = require('express');

const game_controller = require('./controllers/game_controller');

const router = express.Router();

router.get('/', (req, res) => res.json({ online: true }));
router.post('/new-game', game_controller.validate('new_game'), game_controller.new_game);

module.exports = router;