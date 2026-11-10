const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PATH = [
    { x: -45, z: 0 }, { x: -35, z: 0 }, { x: -25, z: 0 },
    { x: -25, z: 20 }, { x: -25, z: 35 },
    { x: 0, z: 35 }, { x: 20, z: 35 },
    { x: 20, z: 15 }, { x: 20, z: -15 },
    { x: 0, z: -15 }, { x: -15, z: -15 },
    { x: -15, z: -35 }, { x: 10, z: -35 },
    { x: 30, z: -35 }, { x: 30, z: -10 }, { x: 30, z: 10 }
];

let STATE = {};
let enemyId = 0;
let gameInterval = null;
const ADMIN_PASSWORD = "admin123"; // Пароль хранится ТОЛЬКО на сервере

function resetGame() {
    STATE = { money: 150, baseHp: 20, wave: 1, enemies: [], towers: [], gameOver: false };
    io.emit('state', STATE);
}

// ... (цикл игры startGameLoop и функция canBuildAt остаются без изменений) ...
// Я их пропущу для краткости, но в твоем файле они должны остаться!

function startGameLoop() {
    if (gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(() => {
        if (STATE.gameOver) return;
        if (Math.random() < 0.025) { 
            STATE.enemies.push({
                id: ++enemyId, pathIndex: 0, progress: 0, x: PATH[0].x, z: PATH[0].z,
                hp: 10, maxHp: 10, speed: 0.02 + (STATE.wave * 0.003), animTime: 0 
            });
        }
        for (let i = STATE.enemies.length - 1; i >= 0; i--) {
            let e = STATE.enemies[i];
            e.animTime = (e.animTime || 0) + 0.1;
            if (e.pathIndex < PATH.length - 1) {
                let target = PATH[e.pathIndex + 1], current = PATH[e.pathIndex];
                let dx = target.x - current.x, dz = target.z - current.z;
                let dist = Math.hypot(dx, dz);
                e.progress += e.speed / dist;
                if (e.progress >= 1.0) { e.pathIndex++; e.progress = 0; e.x = target.x; e.z = target.z; }
                else { e.x = current.x + dx * e.progress; e.z = current.z + dz * e.progress; }
            } else {
                STATE.baseHp -= 1; STATE.enemies.splice(i, 1);
                if (STATE.baseHp <= 0) STATE.gameOver = true;
                continue;
            }
            for (let t of STATE.towers) {
                let distToEnemy = Math.hypot(t.x - e.x, t.z - e.z);
                if (distToEnemy < 14 && Math.random() < 0.02) {
                    e.hp -= t.damage;
                    t.lastShoot = Date.now();
                    if (e.hp <= 0) { STATE.money += 15; STATE.enemies.splice(i, 1); break; }
                }
            }
        }
        io.emit('state', STATE);
    }, 1000 / 60);
}

resetGame();
startGameLoop();

function canBuildAt(x, z) {
    let minDistToPath = 999;
    for (let i = 0; i < PATH.length - 1; i++) {
        let p1 = PATH[i], p2 = PATH[i + 1];
        let A = x - p1.x, B = z - p1.z;
        let C = p2.x - p1.x, D = p2.z - p1.z;
        let dot = A * C + B * D;
        let len_sq = C * C + D * D;
        let param = len_sq != 0 ? dot / len_sq : -1;
        let xx, zz;
        if (param < 0) { xx = p1.x; zz = p1.z; }
        else if (param > 1) { xx = p2.x; zz = p2.z; }
        else { xx = p1.x + param * C; zz = p1.z + param * D; }
        let dist = Math.hypot(x - xx, z - zz);
        if (dist < minDistToPath) minDistToPath = dist;
    }
    if (minDistToPath < 3 || minDistToPath > 8) return false;
    for (let t of STATE.towers) {
        if (Math.hypot(t.x - x, t.z - z) < 3) return false;
    }
    return true;
}

io.on('connection', (socket) => {
    socket.emit('state', STATE);
    
    socket.on('new_game', () => { resetGame(); });

    socket.on('build', (data) => {
        // ЗАЩИТА: Сервер сам проверяет координаты и деньги
        if (STATE.money >= 50 && canBuildAt(data.x, data.z)) {
            STATE.money -= 50;
            // ЗАЩИТА: Сервер сам ставит урон (5), а не берет из клиента
            STATE.towers.push({ x: data.x, z: data.z, damage: 5 });
        } else {
            socket.emit('error', 'Недостаточно денег или нельзя строить здесь!');
        }
    });

    // ЗАЩИТА: Админ-команды требуют пароль
    socket.on('admin_add_money', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            STATE.money += 1000;
            io.emit('state', STATE);
        } else {
            socket.emit('error', 'Неверный пароль!');
        }
    });

    socket.on('admin_kill_all', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            STATE.enemies = [];
            io.emit('state', STATE);
        } else {
            socket.emit('error', 'Неверный пароль!');
        }
    });

    // ЗАЩИТА: Загрузка проверяет данные
    socket.on('load_save', (save) => {
        // Проверяем, что деньги и здоровье не отрицательные и не слишком большие
        if (typeof save.money === 'number' && save.money >= 0 && save.money <= 10000 &&
            typeof save.baseHp === 'number' && save.baseHp >= 0 && save.baseHp <= 20) {
            
            STATE.money = save.money;
            STATE.baseHp = save.baseHp;
            
            // Проверяем башни: каждая должна быть в допустимых координатах и с уроном 5
            STATE.towers = save.towers.filter(t => 
                t && typeof t.x === 'number' && typeof t.z === 'number' &&
                canBuildAt(t.x, t.z) && t.damage === 5
            );
            
            STATE.enemies = []; // Очищаем зомби
            io.emit('state', STATE);
        } else {
            socket.emit('error', 'Некорректные данные сохранения!');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));