// web/server.js
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs').promises; // Используем асинхронные методы fs
const bodyParser = require('body-parser'); // Для парсинга JSON тела запроса
const SteamUser = require('steam-user');
const botFactory = require('../src/hourBooster');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const CONFIG_PATH = path.join(__dirname, '../config/accounts.json');
const LOG_FILE = path.join(__dirname, '../logs/log.txt');
const LOG_DIR = path.dirname(LOG_FILE);

// --- Инициализация ---
async function ensureLogDir() {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
    } catch (error) {
        console.error("Failed to create log directory:", error);
    }
}
ensureLogDir();

// --- Middleware ---
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.json()); // Используем body-parser для обработки JSON запросов

// --- Глобальные переменные ---
let bots = {}; // Хранилище активных ботов
let configsArray = []; // Кэш конфигурации в памяти

// --- Функции ---

// Загрузка конфигурации из JSON
async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        configsArray = JSON.parse(data);
        console.log(`[Config] Loaded ${configsArray.length} accounts.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn('[Config] accounts.json not found. Creating empty file.');
            configsArray = [];
            await saveConfig(); // Создаем пустой файл
        } else {
            console.error('[Config] Error loading config:', error);
            configsArray = []; // Используем пустой массив в случае ошибки
        }
    }
}

// Сохранение конфигурации в JSON
async function saveConfig() {
    try {
        await fs.writeFile(CONFIG_PATH, JSON.stringify(configsArray, null, 2), 'utf8'); // null, 2 для красивого форматирования
        console.log('[Config] Configuration saved.');
    } catch (error) {
        console.error('[Config] Error saving config:', error);
    }
}

// Логирование
async function writeLog(message) {
    // Функция теперь просто записывает переданное сообщение
    const logLine = `[${new Date().toLocaleString()}] ${message}\n`;
    try {
        await fs.appendFile(LOG_FILE, logLine);
        io.emit('log', logLine); // Отправляем лог клиентам
    } catch (error) {
        console.error("Failed to write log:", error);
        // В случае ошибки записи в файл, выведем сообщение хотя бы в консоль сервера
        console.log(logLine.trim());
    }
}

// Запуск бота
function startBot(config) {
    if (bots[config.username]) {
        writeLog(`[${config.username}] Bot is already running.`);
        return;
    }

    writeLog(`[${config.username}] Starting bot...`);
    const bot = botFactory.buildBot(config);

    bot.on('loggedOn', () => {
        if (!bots[config.username]) {
            bots[config.username] = bot;
        }
        writeLog(`[${config.username}] Logged in successfully. Playing games`);
        io.emit('statusUpdate'); // Обновляем статус на фронте
    });

bot.on('error', err => {
    // Проверяем, содержит ли сообщение об ошибке подстроку 'LoggedInElsewhere'
    const isLoggedInElsewhere = err && typeof err.message === 'string' && err.message.includes('LoggedInElsewhere');

    let logMessage;

    if (isLoggedInElsewhere) {
        // Если это ошибка LoggedInElsewhere, используем пользовательское сообщение
        writeLog(`[${config.username}] Account logged in elsewhere, attempting to reconnect.`); // Логируем техническое сообщение для отладки
    } else {
        // Для всех других ошибок логируем исходное сообщение об ошибке
        logMessage = `[${config.username}] Error: ${err}`;
        writeLog(logMessage); // Логируем исходное сообщение об ошибке
    }


    // Попробуем удалить старый login key при неверном пароле
    if (err.eresult === SteamUser.EResult.InvalidPassword && bot.loginKeyPath) {
        fs.unlink(bot.loginKeyPath).catch(e => writeLog(`[${config.username}] Could not delete old login key: ${e.message}`));
    }

    // Очищаем бота из активных при ошибке, чтобы можно было перезапустить
    // Исключаем удаление при LoggedInElsewhere, чтобы статус оставался "активен" (в процессе переподключения)
    if (bots[config.username] && !isLoggedInElsewhere) {
        delete bots[config.username];
        io.emit('statusUpdate'); // Оповещаем об обновлении статуса
    }
});

    bot.on('friendMessage', (steamID, message) => {
        // Логика обработки сообщений осталась прежней, но обернута в writeLog
        if (bot.receiveMessages) {
			writeLog(`[${bot.username}] Message from ${steamID}: ${message}`);
		}
        // Логика сохранения в файл осталась прежней
		if (bot.saveMessages) {
			const dir = path.join(__dirname, `../messages/${bot.username}`);
			const file = path.join(dir, `${steamID}.log`);
			fs.mkdir(dir, { recursive: true })
                .then(() => fs.appendFile(file, `${message}\n`))
                .catch(err => writeLog(`[${bot.username}] Error saving message: ${err}`));
		}
		if (!bot.messageReceived[steamID] && bot.autoMessage) {
			bot.chatMessage(steamID, bot.autoMessage);
			bot.messageReceived[steamID] = true;
		}
    });

    bot.on('steamGuardRequested', () => {
        io.emit('steamGuardRequest', { username: config.username });
        writeLog(`[${config.username}] Steam Guard code required.`);
    });

     // Обработчик события 'disconnected'
    bot.on('disconnected', (eresult, msg) => {
        writeLog(`[${config.username}] Disconnected: ${msg} (Result: ${eresult})`);
        delete bots[config.username]; // Убираем из активных
        io.emit('statusUpdate'); // Обновляем статус на фронте
    });


    bot.doLogin();
    bots[config.username] = bot;
    io.emit('statusUpdate'); // Обновляем статус на фронте
}

// Остановка бота
function stopBot(username) {
    const bot = bots[username];
    if (!bot) {
         writeLog(`[${username}] Bot is not running.`);
         return;
    }

    writeLog(`[${username}] Stopping bot...`);
    try {
        bot.logOff();
    } catch (e) {
        writeLog(`[${username}] Error during logOff: ${e.message}`);
    } finally {
        delete bots[username]; // Удаляем в любом случае
        io.emit('statusUpdate'); // Обновляем статус на фронте
        writeLog(`[${username}] Bot stopped.`);
    }
}

// --- API Маршруты ---

// Получить список аккаунтов и их статус
app.get('/api/accounts', (req, res) => {
    const accountList = configsArray.map(config => ({
        username: config.username,
        // Не храним пароль и sharedSecret в ответе API
        enableStatus: config.enableStatus,
        gamesAndStatus: config.gamesAndStatus,
        replyMessage: config.replyMessage,
        receiveMessages: config.receiveMessages,
        saveMessages: config.saveMessages,
        running: Boolean(bots[config.username]), // Статус берем из активных ботов
    }));
    res.json(accountList);
});

// Получить логи
app.get('/api/logs', async (req, res) => {
    try {
        const logs = await fs.readFile(LOG_FILE, 'utf8');
        res.type('text/plain').send(logs);
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.type('text/plain').send(''); // Отправляем пустую строку, если файла нет
        } else {
            console.error("Failed to read logs:", error);
            res.status(500).send('Error reading logs');
        }
    }
});

// Запустить бота
app.post('/api/start', (req, res) => {
    const { username } = req.body;
    const config = configsArray.find(cfg => cfg.username === username);

    if (!config) {
        return res.status(404).json({ message: 'Account not found' });
    }
    if (bots[username]) {
         return res.status(400).json({ message: 'Bot already running' });
    }

    startBot(config); // Используем функцию для запуска
    res.json({ message: 'Start command received' }); // Ответ сразу, запуск асинхронный
});

// Остановить бота
app.post('/api/stop', (req, res) => {
    const { username } = req.body;
    if (!bots[username]) {
        return res.status(400).json({ message: 'Bot not running' });
    }

    stopBot(username); // Используем функцию для остановки
    res.json({ message: 'Stop command received' });
});

// Отправить Steam Guard код
app.post('/api/submit-guard', (req, res) => {
    const { username, code } = req.body;
    const bot = bots[username];

    if (!bot || !bot._waitingForGuard) {
        return res.status(400).json({ message: 'No Steam Guard request pending for this account or bot not running' });
    }

    bot.submitSteamGuardCode(code);
    writeLog(`[${username}] Steam Guard code submitted.`);
    res.json({ message: 'Code submitted' });
});

// Добавить новый аккаунт
app.post('/api/add-account', async (req, res) => {
    const newAccount = req.body; // Ожидаем полный объект аккаунта

    // Простая валидация
    if (!newAccount || !newAccount.username || !newAccount.password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }
    if (configsArray.some(acc => acc.username === newAccount.username)) {
        return res.status(409).json({ message: 'Account with this username already exists' });
    }

     // Устанавливаем значения по умолчанию, если не переданы
    newAccount.sharedSecret = newAccount.sharedSecret || '';
    newAccount.enableStatus = newAccount.enableStatus !== undefined ? newAccount.enableStatus : true;
    newAccount.gamesAndStatus = newAccount.gamesAndStatus || [];
    newAccount.replyMessage = newAccount.replyMessage || '';
    newAccount.receiveMessages = newAccount.receiveMessages !== undefined ? newAccount.receiveMessages : false;
    newAccount.saveMessages = newAccount.saveMessages !== undefined ? newAccount.saveMessages : false;

    configsArray.push(newAccount);
    await saveConfig();
    writeLog(`[${newAccount.username}] Account added.`);
    io.emit('statusUpdate'); // Обновляем список на фронте
    res.status(201).json({ message: 'Account added successfully' });
});

// Редактировать существующий аккаунт
app.put('/api/edit-account/:username', async (req, res) => {
    const username = req.params.username;
    const updatedData = req.body;
    const accountIndex = configsArray.findIndex(acc => acc.username === username);

    if (accountIndex === -1) {
        return res.status(404).json({ message: 'Account not found' });
    }

    // Обновляем только переданные поля, сохраняя username
    const originalAccount = configsArray[accountIndex];
    configsArray[accountIndex] = {
        ...originalAccount, // Сохраняем старые значения
        ...updatedData,    // Перезаписываем новыми
        username: originalAccount.username // Гарантируем, что username не изменился
    };

    // Важно: Если бот запущен, изменения вступят в силу только после перезапуска.
    // Останавливаем бота, если он был запущен, чтобы избежать несоответствий
    if (bots[username]) {
        writeLog(`[${username}] Account edited. Stopping the bot to apply changes. Please restart manually.`);
        stopBot(username); // Останавливаем бота
    }

    await saveConfig();
    writeLog(`[${username}] Account updated.`);
    io.emit('statusUpdate'); // Обновляем список на фронте
    res.json({ message: 'Account updated successfully. Restart the bot if it was running.' });
});

// Удалить аккаунт
app.delete('/api/delete-account/:username', async (req, res) => {
    const username = req.params.username;
    const accountIndex = configsArray.findIndex(acc => acc.username === username);

    if (accountIndex === -1) {
        return res.status(404).json({ message: 'Account not found' });
    }

    // Останавливаем бота перед удалением конфигурации
    if (bots[username]) {
        stopBot(username);
    }

    configsArray.splice(accountIndex, 1); // Удаляем из массива
    await saveConfig();
    writeLog(`[${username}] Account deleted.`);
    io.emit('statusUpdate'); // Обновляем список на фронте
    res.json({ message: 'Account deleted successfully' });
});


// --- WebSocket ---
io.on('connection', socket => {
    console.log('[SocketIO] Client connected');
    socket.on('disconnect', () => {
        console.log('[SocketIO] Client disconnected');
    });
});

// --- Запуск сервера ---
const PORT = 3000;
server.listen(PORT, async () => {
    await loadConfig(); // Загружаем конфиг перед стартом
    console.log(`[Server] Web panel running at http://localhost:${PORT}`);
    // Опционально: автоматически запускать ботов при старте сервера
    // configsArray.forEach(config => startBot(config));
});