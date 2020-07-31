import Vue from 'vue'
import Vuex from 'vuex'
import createPersistedState from 'vuex-persistedstate'
import VueSocketIO from 'vue-socket.io'
// import axios from 'axios'
// import VueAxios from 'vue-axios'
import { BootstrapVue, IconsPlugin } from 'bootstrap-vue'

import App from './App.vue'
import router from './router'

Vue.config.productionTip = false

Vue.use(Vuex)

const store = new Vuex.Store({
	state: {
		username: null,
		game: null,
		status: {
			code: 'loading',
			message: 'loading...',
			win: false,
			draw: false,
			lose: false,
			result: null
		},
		time: {
			t1: null,
			t2: null
		}
	},
	mutations: {
		update_username (state, username) {
			state.username = username;
		},
		update_game (state, game) {
			state.game = game;
		},
		update_status_code (state, status_code) {
			state.status.code = status_code;
		},
		update_status_message (state, status_message) {
			state.status.message = status_message;
		},
		update_status_win (state, status_win) {
			state.status.win = status_win;
		},
		update_status_draw (state, status_draw) {
			state.status.draw = status_draw;
		},
		update_status_lose (state, status_lose) {
			state.status.lose = status_lose;
		},
		update_status_result (state, status_result) {
			state.status.result = status_result;
		},
		update_time (state, time) {
			state.time = time;
		}
	},
	plugins: [
		createPersistedState({storage: window.sessionStorage})
	]
});

Vue.use(new VueSocketIO({
	debug: true,
	connection: 'http://localhost:8085',
	vuex: {
		store,
		actionPrefix: 'SOCKET_',
		mutationPrefix: 'SOCKET_'
	},
	options: {
		// path: "/my-app/"
		// autoConnect: false
	}
}));

// Vue.use(VueAxios, axios)

Vue.use(BootstrapVue);
Vue.use(IconsPlugin);

import VModal from 'vue-js-modal'
Vue.use(VModal)

new Vue({
	router,
	store,
	render: h => h(App),
}).$mount('#app')
