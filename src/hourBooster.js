const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs');
const path = require('path');

const botFactory = {};

botFactory.buildBot = function (config) {
	const loginKeysPath = path.join(__dirname, '../login_keys');
	const loginKeyFile = path.join(loginKeysPath, `${config.username}.txt`);

	if (!fs.existsSync(loginKeysPath)) fs.mkdirSync(loginKeysPath, { recursive: true });

	const bot = new SteamUser({
		autoRelogin: true,
		rememberPassword: true,
		singleSentryfile: false,
		machineName: 'vaporBooster',
		dataDirectory: path.join(__dirname, '../accounts_data') // 🔥 добавлено, чтобы сохранялся cm_list.json
	});

	bot.username = config.username;
	bot.password = config.password;
	bot.sharedSecret = config.sharedSecret;
	bot.games = config.gamesAndStatus;
	bot.enableStatus = config.enableStatus;
	bot.autoMessage = config.replyMessage;
	bot.receiveMessages = config.receiveMessages;
	bot.saveMessages = config.saveMessages;
	bot.messageReceived = {};
	bot.loginKeyPath = loginKeyFile;

	bot.doLogin = function () {
		if (fs.existsSync(bot.loginKeyPath)) {
			const loginKey = fs.readFileSync(bot.loginKeyPath, 'utf8').trim();
			console.log(`[${bot.username}] 🔑 Используем loginKey`);
			bot.logOn({
				accountName: bot.username,
				loginKey: loginKey,
				rememberPassword: true,
				machineName: 'vaporBooster'
			});
		} else {
			console.log(`[${bot.username}] 🔐 Используем пароль`);
			bot.logOn({
				accountName: bot.username,
				password: bot.password,
				rememberPassword: true,
				machineName: 'vaporBooster'
			});
		}
	};

	bot.on('loggedOn', () => {
		console.log(`[${bot.username}] ✅ Вошёл в Steam: ${bot.steamID.getSteamID64()}`);
		bot.setPersona(bot.enableStatus ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible);
		bot.gamesPlayed(bot.games);
	});

	bot.on('loginKey', key => {
		fs.writeFileSync(bot.loginKeyPath, key);
		console.log(`[${bot.username}] 💾 LoginKey сохранён: ${bot.loginKeyPath}`);
	});

	bot.on('error', err => {
		console.log(`[${bot.username}] ❌ Ошибка: ${err}`);
		if (err.eresult === SteamUser.EResult.InvalidPassword) {
			if (fs.existsSync(bot.loginKeyPath)) {
				fs.unlinkSync(bot.loginKeyPath);
				console.log(`[${bot.username}] ❌ Удалён старый loginKey`);
			}
		}
		setTimeout(() => bot.doLogin(), 60 * 1000);
	});

	bot.on('steamGuard', (domain, callback) => {
		if (bot.sharedSecret) {
			const code = SteamTotp.generateAuthCode(bot.sharedSecret);
			console.log(`[${bot.username}] 🛡️ Steam Guard код: ${code}`);
			callback(code);
		} else {
			console.log(`[${bot.username}] 🛡️ Требуется ручной ввод Steam Guard`);
			bot._waitingForGuard = true;
			bot._steamGuardCallback = callback;
			bot.emit('steamGuardRequested');
		}
	});

	bot.submitSteamGuardCode = function (code) {
		if (bot._waitingForGuard && bot._steamGuardCallback) {
			bot._steamGuardCallback(code);
			bot._waitingForGuard = false;
			delete bot._steamGuardCallback;
		}
	};

	bot.on('friendMessage', function (steamID, message) {
		if (bot.receiveMessages) {
			console.log(`[${bot.username}] Сообщение от ${steamID}: ${message}`);
		}
		if (bot.saveMessages) {
			const dir = `${__dirname}/../messages/${bot.username}`;
			const file = `${dir}/${steamID}.log`;
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFile(file, `${message}\n`, err => {
				if (err) console.log(`[${bot.username}] ❌ Ошибка при сохранении сообщения`);
			});
		}
		if (!bot.messageReceived[steamID] && bot.autoMessage) {
			bot.chatMessage(steamID, bot.autoMessage);
			bot.messageReceived[steamID] = true;
		}
	});

	return bot;
};

module.exports = botFactory;
