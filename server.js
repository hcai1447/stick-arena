const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ============ 常量 ============
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const ARENA_W = 800;
const ARENA_H = 600;
const PLAYER_RADIUS = 12;
const PLAYER_SPEED = 3;
const ATTACK_RANGE = 35;
ATTACK_COOLDOWN_MS = 400;
const ATTACK_DAMAGE = 1;
const KNOCKBACK_FORCE = 8;
const MAX_HP = 5;
const RESPAWN_MS = 3000;
const WIN_SCORE = 5;

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
const NAMES = ['红方', '蓝方', '绿方', '黄方'];

// 地图障碍物 (x, y, w, h)
const WALLS = [
  { x: 380, y: 280, w: 40, h: 40 },
  { x: 180, y: 130, w: 60, h: 20 },
  { x: 560, y: 130, w: 60, h: 20 },
  { x: 180, y: 450, w: 60, h: 20 },
  { x: 560, y: 450, w: 60, h: 20 },
];

// ============ 房间管理 ============
const rooms = new Map();
let nextRoomId = 1;

function createRoom() {
  const id = String(nextRoomId++);
  const room = {
    id,
    players: new Map(),
    state: 'waiting', // waiting | playing | roundEnd
    nextSlot: 0,
    tickTimer: null,
    roundEndTimer: null,
  };
  rooms.set(id, room);
  return room;
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const [, p] of room.players) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

// ============ 游戏逻辑 ============
function spawnPos(slot) {
  const spawns = [
    { x: 100, y: 100 },
    { x: ARENA_W - 100, y: 100 },
    { x: 100, y: ARENA_H - 100 },
    { x: ARENA_W - 100, y: ARENA_H - 100 },
  ];
  return spawns[slot % 4];
}

function startRound(room) {
  room.state = 'playing';
  let slot = 0;
  for (const [, p] of room.players) {
    const pos = spawnPos(slot);
    p.x = pos.x;
    p.y = pos.y;
    p.hp = MAX_HP;
    p.alive = true;
    p.vx = 0;
    p.vy = 0;
    p.facing = 0;
    p.attackCooldown = 0;
    p.respawnTimer = 0;
    slot++;
  }
  broadcastRoom(room, { type: 'roundStart' });
}

function rectCollide(x, y, r, wall) {
  const cx = Math.max(wall.x, Math.min(x, wall.x + wall.w));
  const cy = Math.max(wall.y, Math.min(y, wall.y + wall.h));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

function resolveWalls(x, y, r) {
  for (const w of WALLS) {
    if (rectCollide(x, y, r, w)) {
      // 推出障碍物
      const cx = Math.max(w.x, Math.min(x, w.x + w.w));
      const cy = Math.max(w.y, Math.min(y, w.y + w.h));
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        x = cx + (dx / dist) * r;
        y = cy + (dy / dist) * r;
      }
    }
  }
  return { x, y };
}

function gameTick(room) {
  const now = Date.now();
  const players = [...room.players.values()];

  for (const p of players) {
    if (!p.alive) {
      if (p.respawnTimer > 0) {
        p.respawnTimer -= TICK_MS;
        if (p.respawnTimer <= 0) {
          const pos = spawnPos(p.slot);
          p.x = pos.x;
          p.y = pos.y;
          p.hp = MAX_HP;
          p.alive = true;
        }
      }
      continue;
    }

    // 移动
    const len = Math.sqrt(p.inputX * p.inputX + p.inputY * p.inputY);
    if (len > 0) {
      p.vx = (p.inputX / len) * PLAYER_SPEED;
      p.vy = (p.inputY / len) * PLAYER_SPEED;
      p.facing = Math.atan2(p.inputY, p.inputX);
    } else {
      p.vx = 0;
      p.vy = 0;
    }

    p.x += p.vx;
    p.y += p.vy;

    // 边界
    p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, p.y));

    // 墙壁碰撞
    const resolved = resolveWalls(p.x, p.y, PLAYER_RADIUS);
    p.x = resolved.x;
    p.y = resolved.y;

    // 攻击冷却
    if (p.attackCooldown > 0) p.attackCooldown -= TICK_MS;

    // 攻击判定
    if (p.wantsAttack && p.attackCooldown <= 0) {
      p.attackCooldown = ATTACK_COOLDOWN_MS;
      p.wantsAttack = false;

      // 冲刺一小段
      p.x += Math.cos(p.facing) * 15;
      p.y += Math.sin(p.facing) * 15;
      const res2 = resolveWalls(p.x, p.y, PLAYER_RADIUS);
      p.x = res2.x;
      p.y = res2.y;

      for (const other of players) {
        if (other === p || !other.alive) continue;
        const dx = other.x - p.x;
        const dy = other.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < ATTACK_RANGE) {
          other.hp -= ATTACK_DAMAGE;
          // 击退
          if (dist > 0) {
            other.x += (dx / dist) * KNOCKBACK_FORCE;
            other.y += (dy / dist) * KNOCKBACK_FORCE;
            const res3 = resolveWalls(other.x, other.y, PLAYER_RADIUS);
            other.x = res3.x;
            other.y = res3.y;
          }
          // 边界
          other.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, other.x));
          other.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, other.y));

          if (other.hp <= 0) {
            other.alive = false;
            other.hp = 0;
            other.respawnTimer = RESPAWN_MS;
            p.score = (p.score || 0) + 1;

            // 检查胜利
            if (p.score >= WIN_SCORE) {
              room.state = 'roundEnd';
              broadcastRoom(room, {
                type: 'gameOver',
                winner: p.slot,
                winnerName: NAMES[p.slot],
                scores: players.map(pp => ({ slot: pp.slot, name: pp.name, score: pp.score || 0 })),
              });
              clearTimeout(room.tickTimer);
              return;
            }
          }

          broadcastRoom(room, {
            type: 'hit',
            attacker: p.slot,
            target: other.slot,
            targetHp: other.hp,
          });
        }
      }
    }
  }

  // 广播状态
  broadcastRoom(room, {
    type: 'state',
    players: players.map(p => ({
      slot: p.slot,
      name: p.name,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      hp: p.hp,
      alive: p.alive,
      facing: Math.round(p.facing * 100) / 100,
      moving: p.vx !== 0 || p.vy !== 0,
      score: p.score || 0,
      attacking: p.attackCooldown > ATTACK_COOLDOWN_MS * 0.6,
    })),
    t: now,
  });

  room.tickTimer = setTimeout(() => gameTick(room), TICK_MS);
}

// ============ WebSocket ============
wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerData = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // 找一个有空位的房间，或创建新的
      let room = null;
      for (const [, r] of rooms) {
        if (r.players.size < 4 && r.state === 'waiting') {
          room = r;
          break;
        }
      }
      if (!room) room = createRoom();

      const slot = room.nextSlot++;
      playerData = {
        ws,
        slot,
        name: msg.name || NAMES[slot],
        x: 0, y: 0, hp: MAX_HP, alive: true,
        vx: 0, vy: 0, facing: 0,
        inputX: 0, inputY: 0,
        attackCooldown: 0, wantsAttack: false,
        respawnTimer: 0,
        score: 0,
      };
      room.players.set(slot, playerData);
      currentRoom = room;

      // 初始化位置
      const pos = spawnPos(slot);
      playerData.x = pos.x;
      playerData.y = pos.y;

      ws.send(JSON.stringify({
        type: 'joined',
        slot,
        roomId: room.id,
        color: COLORS[slot],
        name: NAMES[slot],
        arena: { w: ARENA_W, h: ARENA_H },
        walls: WALLS,
        maxHp: MAX_HP,
        winScore: WIN_SCORE,
      }));

      broadcastRoom(room, {
        type: 'playerJoined',
        slot,
        name: NAMES[slot],
        color: COLORS[slot],
        playerCount: room.players.size,
      });

      // 2人以上开始正式对战，1人也发状态让他看到自己
      if (room.players.size >= 2 && room.state === 'waiting') {
        startRound(room);
      } else if (room.state === 'waiting') {
        broadcastRoom(room, {
          type: 'roundStart',
        });
        gameTick(room);
      }
    }

    if (msg.type === 'input' && currentRoom && playerData) {
      playerData.inputX = msg.x || 0;
      playerData.inputY = msg.y || 0;
    }

    if (msg.type === 'attack' && currentRoom && playerData) {
      playerData.wantsAttack = true;
    }
  });

  ws.on('close', () => {
    if (currentRoom && playerData) {
      currentRoom.players.delete(playerData.slot);
      broadcastRoom(currentRoom, {
        type: 'playerLeft',
        slot: playerData.slot,
        playerCount: currentRoom.players.size,
      });
      if (currentRoom.players.size === 0) {
        clearTimeout(currentRoom.tickTimer);
        rooms.delete(currentRoom.id);
      } else if (currentRoom.state === 'playing' && currentRoom.players.size < 2) {
        // 人不够，结束
        currentRoom.state = 'waiting';
        clearTimeout(currentRoom.tickTimer);
        broadcastRoom(currentRoom, { type: 'roundAbort', reason: '玩家不足' });
      }
    }
  });
});

// ============ 启动 ============
const PORT = process.env.PORT || 3456;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`火柴人大乱斗服务已启动: http://localhost:${PORT}`);
  console.log(`手机请访问: http://<你的局域网IP>:${PORT}`);
});
