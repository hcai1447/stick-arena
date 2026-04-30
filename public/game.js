(() => {
  // ============ DOM ============
  const lobbyEl = document.getElementById('lobby');
  const gameEl = document.getElementById('game');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const joinBtn = document.getElementById('joinBtn');
  const nameInput = document.getElementById('nameInput');
  const statusEl = document.getElementById('status');
  const scoresEl = document.getElementById('scores');
  const attackBtn = document.getElementById('attackBtn');
  const joystickBase = document.getElementById('joystickBase');
  const joystickKnob = document.getElementById('joystickKnob');
  const gameOverEl = document.getElementById('gameOver');
  const winnerText = document.getElementById('winnerText');
  const finalScoresEl = document.getElementById('finalScores');
  const playAgainBtn = document.getElementById('playAgainBtn');

  // ============ 常量 ============
  const PLAYER_SPEED = 3;

  // ============ 状态 ============
  let ws = null;
  let mySlot = -1;
  let gameState = null;
  let arena = { w: 800, h: 600 };
  let walls = [];
  let maxHp = 5;
  let winScore = 5;
  let colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  let names = ['红方', '蓝方', '绿方', '黄方'];
  let animFrame = 0;
  let particles = [];
  let shakeTimer = 0;
  let shakeIntensity = 0;

  // 客户端预测
  let localX = 0, localY = 0;
  let localInputX = 0, localInputY = 0;
  let lastServerX = 0, lastServerY = 0;
  let lastInputSend = 0;
  const INPUT_SEND_INTERVAL = 33; // ~30fps 发送输入

  // 虚拟摇杆状态
  let joyActive = false;
  let joyX = 0, joyY = 0;
  const JOY_RADIUS = 50;

  // ============ Canvas 自适应 ============
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ============ 缩放计算 ============
  function getScale() {
    return Math.min(canvas.width / arena.w, canvas.height / arena.h);
  }
  function getOffset() {
    const s = getScale();
    return {
      x: (canvas.width - arena.w * s) / 2,
      y: (canvas.height - arena.h * s) / 2,
    };
  }

  // ============ WebSocket ============
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      statusEl.textContent = '已连接服务器';
      joinBtn.disabled = false;
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      statusEl.textContent = '连接断开，3秒后重连...';
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      statusEl.textContent = '连接失败';
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendInput(x, y) {
    localInputX = x;
    localInputY = y;
    const now = Date.now();
    if (now - lastInputSend >= INPUT_SEND_INTERVAL) {
      lastInputSend = now;
      send({ type: 'input', x, y });
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        mySlot = msg.slot;
        arena = msg.arena;
        walls = msg.walls;
        maxHp = msg.maxHp;
        winScore = msg.winScore;
        lobbyEl.style.display = 'none';
        gameEl.style.display = 'block';
        resizeCanvas();
        break;

      case 'playerJoined':
        names[msg.slot] = msg.name;
        colors[msg.slot] = msg.color;
        statusEl.textContent = `${msg.name} 加入了 (${msg.playerCount}/4)`;
        break;

      case 'playerLeft':
        statusEl.textContent = `有玩家离开了 (${msg.playerCount}/4)`;
        break;

      case 'roundStart':
        gameOverEl.style.display = 'none';
        particles = [];
        break;

      case 'state':
        // 用服务器状态更新其他玩家，本地玩家用服务器位置做校正
        for (const p of msg.players) {
          if (p.name) names[p.slot] = p.name;
          if (p.slot === mySlot) {
            // 校正本地位置（平滑过渡）
            lastServerX = p.x;
            lastServerY = p.y;
            const dx = p.x - localX;
            const dy = p.y - localY;
            // 如果偏差太大直接同步，否则平滑修正
            if (Math.abs(dx) > 30 || Math.abs(dy) > 30) {
              localX = p.x;
              localY = p.y;
            } else {
              localX += dx * 0.3;
              localY += dy * 0.3;
            }
            p.x = localX;
            p.y = localY;
          }
        }
        gameState = msg.players;
        updateHUD();
        break;

      case 'hit':
        const target = msg.target;
        if (gameState && gameState[target]) {
          const p = gameState[target];
          spawnHitParticles(p.x, p.y, colors[target]);
          if (target === mySlot) {
            shakeTimer = 8;
            shakeIntensity = 4;
          }
        }
        break;

      case 'gameOver':
        if (msg.scores) {
          for (const s of msg.scores) {
            if (s.name) names[s.slot] = s.name;
          }
        }
        showGameOver(msg);
        break;

      case 'roundAbort':
        statusEl.textContent = msg.reason;
        break;
    }
  }

  // ============ HUD ============
  function updateHUD() {
    if (!gameState) return;
    scoresEl.innerHTML = gameState.map(p =>
      `<span style="color:${p.alive ? colors[p.slot] : '#555'}">${names[p.slot]}: ${p.score}</span>`
    ).join(' | ');
  }

  // ============ 游戏结束 ============
  function showGameOver(msg) {
    gameOverEl.style.display = 'flex';
    winnerText.textContent = `${msg.winnerName} 获胜!`;
    finalScoresEl.innerHTML = msg.scores
      .sort((a, b) => b.score - a.score)
      .map(s => `<div style="color:${colors[s.slot]}">${names[s.slot]}: ${s.score} 击杀</div>`)
      .join('');
  }

  playAgainBtn.addEventListener('click', () => {
    send({ type: 'join', name: nameInput.value.trim() || '' });
    gameOverEl.style.display = 'none';
  });

  // ============ 客户端预测移动 ============
  function applyLocalPrediction() {
    if (mySlot < 0 || !gameState) return;
    const me = gameState.find(p => p.slot === mySlot);
    if (!me || !me.alive) return;

    const len = Math.sqrt(localInputX * localInputX + localInputY * localInputY);
    if (len > 0) {
      localX += (localInputX / len) * PLAYER_SPEED;
      localY += (localInputY / len) * PLAYER_SPEED;
    }

    // 边界
    localX = Math.max(12, Math.min(arena.w - 12, localX));
    localY = Math.max(12, Math.min(arena.h - 12, localY));

    me.x = localX;
    me.y = localY;
    me.moving = len > 0;
    if (len > 0) me.facing = Math.atan2(localInputY, localInputX);
  }

  // ============ 粒子效果 ============
  function spawnHitParticles(x, y, color) {
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 15 + Math.random() * 10,
        maxLife: 25,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  // ============ 绘制火柴人 ============
  function drawStickFigure(x, y, facing, color, moving, alive, attacking, hp, slot) {
    const s = getScale();
    const o = getOffset();
    const sx = o.x + x * s;
    const sy = o.y + y * s;
    const r = 12 * s;
    const bodyLen = 14 * s;
    const limbLen = 12 * s;

    if (!alive) {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(sx - 8 * s, sy - 8 * s);
      ctx.lineTo(sx + 8 * s, sy + 8 * s);
      ctx.moveTo(sx + 8 * s, sy - 8 * s);
      ctx.lineTo(sx - 8 * s, sy + 8 * s);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';

    if (hp <= 1 && animFrame % 10 < 5) {
      ctx.globalAlpha = 0.5;
    }

    if (attacking) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 15 * s;
    }

    const walkCycle = moving ? Math.sin(animFrame * 0.3) : 0;

    // 身体
    const bodyTop = sy - bodyLen * 0.3;
    const bodyBot = sy + bodyLen * 0.7;
    ctx.beginPath();
    ctx.moveTo(sx, bodyTop);
    ctx.lineTo(sx, bodyBot);
    ctx.stroke();

    // 头
    ctx.beginPath();
    ctx.arc(sx, bodyTop - r * 0.7, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    // 手臂
    const armY = bodyTop + bodyLen * 0.3;
    const armSpread = moving ? walkCycle * 0.4 : 0;
    if (attacking) {
      const fX = sx + Math.cos(facing) * limbLen * 1.5;
      const fY = armY + Math.sin(facing) * limbLen * 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, armY);
      ctx.lineTo(fX, fY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(fX, fY, 3 * s, 0, Math.PI * 2);
      ctx.fill();
      const bX = sx - Math.cos(facing) * limbLen * 0.5;
      const bY = armY - Math.sin(facing) * limbLen * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, armY);
      ctx.lineTo(bX, bY);
      ctx.stroke();
    } else {
      const a1x = sx + Math.cos(facing + Math.PI / 2 + armSpread) * limbLen;
      const a1y = armY + Math.sin(facing + Math.PI / 2 + armSpread) * limbLen * 0.5;
      const a2x = sx + Math.cos(facing - Math.PI / 2 - armSpread) * limbLen;
      const a2y = armY + Math.sin(facing - Math.PI / 2 - armSpread) * limbLen * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, armY);
      ctx.lineTo(a1x, a1y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, armY);
      ctx.lineTo(a2x, a2y);
      ctx.stroke();
    }

    // 腿
    const legSpread = moving ? walkCycle * 0.5 : 0;
    const l1x = sx + Math.cos(facing + Math.PI * 0.7 + legSpread) * limbLen;
    const l1y = bodyBot + Math.abs(Math.sin(facing + Math.PI * 0.7 + legSpread)) * limbLen;
    const l2x = sx + Math.cos(facing + Math.PI * 1.3 - legSpread) * limbLen;
    const l2y = bodyBot + Math.abs(Math.sin(facing + Math.PI * 1.3 - legSpread)) * limbLen;
    ctx.beginPath();
    ctx.moveTo(sx, bodyBot);
    ctx.lineTo(l1x, l1y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx, bodyBot);
    ctx.lineTo(l2x, l2y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // 血条
    const barW = 24 * s;
    const barH = 3 * s;
    const barX = sx - barW / 2;
    const barY = sy - bodyLen - r - 10 * s;
    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barW, barH);
    const hpRatio = hp / maxHp;
    ctx.fillStyle = hpRatio > 0.5 ? '#2ecc71' : hpRatio > 0.2 ? '#f39c12' : '#e74c3c';
    ctx.fillRect(barX, barY, barW * hpRatio, barH);

    // 昵称
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(10, 11 * s)}px 'Courier New'`;
    ctx.textAlign = 'center';
    ctx.fillText(names[slot], sx, barY - 4 * s);
  }

  // ============ 绘制地图 ============
  function drawArena() {
    const s = getScale();
    const o = getOffset();

    ctx.fillStyle = '#16213e';
    ctx.fillRect(o.x, o.y, arena.w * s, arena.h * s);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= arena.w; gx += 40) {
      ctx.beginPath();
      ctx.moveTo(o.x + gx * s, o.y);
      ctx.lineTo(o.x + gx * s, o.y + arena.h * s);
      ctx.stroke();
    }
    for (let gy = 0; gy <= arena.h; gy += 40) {
      ctx.beginPath();
      ctx.moveTo(o.x, o.y + gy * s);
      ctx.lineTo(o.x + arena.w * s, o.y + gy * s);
      ctx.stroke();
    }

    ctx.fillStyle = '#0f3460';
    ctx.strokeStyle = '#1a5276';
    ctx.lineWidth = 2;
    for (const w of walls) {
      ctx.fillRect(o.x + w.x * s, o.y + w.y * s, w.w * s, w.h * s);
      ctx.strokeRect(o.x + w.x * s, o.y + w.y * s, w.w * s, w.h * s);
    }

    ctx.strokeStyle = '#1a5276';
    ctx.lineWidth = 3;
    ctx.strokeRect(o.x, o.y, arena.w * s, arena.h * s);
  }

  // ============ 绘制粒子 ============
  function drawParticles() {
    const s = getScale();
    const o = getOffset();
    for (const p of particles) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(o.x + p.x * s - p.size / 2, o.y + p.y * s - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ============ 主循环 ============
  function gameLoop() {
    animFrame++;
    updateParticles();
    applyLocalPrediction();

    let sx = 0, sy = 0;
    if (shakeTimer > 0) {
      sx = (Math.random() - 0.5) * shakeIntensity;
      sy = (Math.random() - 0.5) * shakeIntensity;
      shakeTimer--;
    }

    ctx.save();
    ctx.translate(sx, sy);

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(-10, -10, canvas.width + 20, canvas.height + 20);

    drawArena();
    drawParticles();

    if (gameState) {
      for (const p of gameState) {
        drawStickFigure(
          p.x, p.y, p.facing, colors[p.slot],
          p.moving, p.alive, p.attacking, p.hp, p.slot
        );
      }
    }

    ctx.restore();
    requestAnimationFrame(gameLoop);
  }

  // ============ 虚拟摇杆 ============
  function handleJoyStart(e) {
    e.preventDefault();
    joyActive = true;
    handleJoyMove(e);
  }

  function handleJoyMove(e) {
    if (!joyActive) return;
    e.preventDefault();
    const touch = e.touches ? e.touches[0] : e;
    const rect = joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOY_RADIUS) {
      dx = (dx / dist) * JOY_RADIUS;
      dy = (dy / dist) * JOY_RADIUS;
    }
    joystickKnob.style.left = (35 + dx) + 'px';
    joystickKnob.style.top = (35 + dy) + 'px';
    joyX = dx / JOY_RADIUS;
    joyY = dy / JOY_RADIUS;
    sendInput(joyX, joyY);
  }

  function handleJoyEnd(e) {
    if (e) e.preventDefault();
    joyActive = false;
    joyX = 0;
    joyY = 0;
    joystickKnob.style.left = '35px';
    joystickKnob.style.top = '35px';
    sendInput(0, 0);
  }

  joystickBase.addEventListener('touchstart', handleJoyStart, { passive: false });
  joystickBase.addEventListener('mousedown', handleJoyStart);
  canvas.addEventListener('touchmove', handleJoyMove, { passive: false });
  canvas.addEventListener('mousemove', handleJoyMove);
  canvas.addEventListener('touchend', handleJoyEnd);
  canvas.addEventListener('mouseup', handleJoyEnd);

  // 攻击
  attackBtn.addEventListener('touchstart', (e) => { e.preventDefault(); send({ type: 'attack' }); }, { passive: false });
  attackBtn.addEventListener('mousedown', () => send({ type: 'attack' }));

  // ============ 键盘控制（PC端） ============
  const keysDown = new Set();
  function updateKeyboardInput() {
    let kx = 0, ky = 0;
    if (keysDown.has('w') || keysDown.has('arrowup')) ky = -1;
    if (keysDown.has('s') || keysDown.has('arrowdown')) ky = 1;
    if (keysDown.has('a') || keysDown.has('arrowleft')) kx = -1;
    if (keysDown.has('d') || keysDown.has('arrowright')) kx = 1;
    sendInput(kx, ky);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); send({ type: 'attack' }); return; }
    keysDown.add(e.key.toLowerCase());
    updateKeyboardInput();
  });
  window.addEventListener('keyup', (e) => {
    keysDown.delete(e.key.toLowerCase());
    updateKeyboardInput();
  });

  // ============ 加入游戏 ============
  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    joinBtn.disabled = true;
    send({ type: 'join', name });
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });

  // ============ 启动 ============
  connect();
  gameLoop();
})();
