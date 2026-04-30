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
  const FIXED_DT = 1 / 60; // 固定逻辑步长 60fps
  const LERP_SPEED = 0.15; // 远程玩家插值速度
  const LOCAL_SMOOTH = 0.25; // 本地位置修正平滑系数
  const BODY_LEAN_FACTOR = 0.15; // 身体倾斜系数

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
  let localX = 0, localY = 0, localFacing = 0;
  let localInputX = 0, localInputY = 0;
  let lastInputSend = 0;
  const INPUT_SEND_INTERVAL = 33;

  // 远程玩家插值缓存（每个玩家存上一个和当前服务器位置）
  const remoteState = {}; // slot -> { prevX, prevY, curX, curY, curFacing, curMoving, t }

  // 固定步长累加器
  let accumulator = 0;
  let lastFrameTime = performance.now();

  // 虚拟摇杆
  let joyActive = false;
  let joyX = 0, joyY = 0;
  let joyTouchId = null;
  const JOY_RADIUS = 50;

  // ============ Canvas 自适应 ============
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ============ 缩放 ============
  function getScale() {
    return Math.min(canvas.width / arena.w, canvas.height / arena.h);
  }
  function getOffset() {
    const s = getScale();
    return { x: (canvas.width - arena.w * s) / 2, y: (canvas.height - arena.h * s) / 2 };
  }

  // ============ 平滑插值工具 ============
  function lerp(a, b, t) { return a + (b - a) * t; }

  function angleLerp(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  // ============ WebSocket ============
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      statusEl.textContent = '已连接服务器';
      joinBtn.disabled = false;
    };
    ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
    ws.onclose = () => {
      statusEl.textContent = '连接断开，3秒后重连...';
      setTimeout(connect, 3000);
    };
    ws.onerror = () => { statusEl.textContent = '连接失败'; };
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
        delete remoteState[msg.slot];
        break;

      case 'roundStart':
        gameOverEl.style.display = 'none';
        particles = [];
        for (const key in remoteState) delete remoteState[key];
        break;

      case 'state':
        for (const p of msg.players) {
          if (p.name) names[p.slot] = p.name;

          if (p.slot === mySlot) {
            // 本地玩家：客户端是渲染的唯一来源
            // 服务器位置只在严重偏差时硬同步，小偏差完全忽略
            const dx = p.x - localX;
            const dy = p.y - localY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 50) {
              // 严重偏差（比如被击退、重生），直接同步
              localX = p.x;
              localY = p.y;
            }
            // 偏差<50：忽略，不做任何修正，避免"拉扯"
            // hp、alive、score等非位置属性正常更新
            const me = gameState ? gameState.find(pp => pp.slot === mySlot) : null;
            if (me) {
              me.hp = p.hp;
              me.alive = p.alive;
              me.score = p.score;
              me.attacking = p.attacking;
            }
          } else {
            // 远程玩家：存入插值缓冲
            if (!remoteState[p.slot]) {
              remoteState[p.slot] = {
                prevX: p.x, prevY: p.y,
                curX: p.x, curY: p.y,
                curFacing: p.facing, curMoving: p.moving,
                t: 1
              };
            } else {
              const rs = remoteState[p.slot];
              rs.prevX = rs.curX;
              rs.prevY = rs.curY;
              rs.curX = p.x;
              rs.curY = p.y;
              rs.curFacing = p.facing;
              rs.curMoving = p.moving;
              rs.t = 0;
            }
          }
        }
        // 只在首次或roundStart时整体赋值，之后只更新非位置属性
        if (!gameState || gameState.length !== msg.players.length) {
          gameState = msg.players;
        }
        updateHUD();
        break;

      case 'hit': {
        const target = msg.target;
        const p = getRenderState(target);
        if (p) {
          spawnHitParticles(p.x, p.y, colors[target]);
          if (target === mySlot) {
            shakeTimer = 8;
            shakeIntensity = 4;
          }
        }
        break;
      }

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

  // 获取玩家的渲染状态（远程玩家用插值后的位置）
  function getRenderState(slot) {
    if (!gameState) return null;
    const base = gameState.find(p => p.slot === slot);
    if (!base) return null;

    if (slot === mySlot) {
      return {
        ...base,
        x: localX,
        y: localY,
        facing: localFacing,
        moving: (localInputX !== 0 || localInputY !== 0)
      };
    }

    const rs = remoteState[slot];
    if (rs && rs.t < 1) {
      return {
        ...base,
        x: lerp(rs.prevX, rs.curX, rs.t),
        y: lerp(rs.prevY, rs.curY, rs.t),
        facing: rs.curFacing,
        moving: rs.curMoving
      };
    }

    return base;
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

  // ============ 固定步长逻辑更新 ============
  function fixedUpdate() {
    if (mySlot < 0 || !gameState) return;

    // 本地预测
    const len = Math.sqrt(localInputX * localInputX + localInputY * localInputY);
    if (len > 0.1) {
      localX += (localInputX / len) * PLAYER_SPEED;
      localY += (localInputY / len) * PLAYER_SPEED;
      localFacing = angleLerp(localFacing, Math.atan2(localInputY, localInputX), 0.3);
    }
    localX = Math.max(12, Math.min(arena.w - 12, localX));
    localY = Math.max(12, Math.min(arena.h - 12, localY));

    // 远程玩家插值推进
    for (const slot in remoteState) {
      const rs = remoteState[slot];
      if (rs.t < 1) {
        rs.t = Math.min(1, rs.t + LERP_SPEED);
      }
    }
  }

  // ============ 粒子 ============
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
  function drawStickFigure(x, y, facing, color, moving, alive, attacking, hp, slot, velX, velY) {
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
      ctx.moveTo(sx - 8 * s, sy - 8 * s); ctx.lineTo(sx + 8 * s, sy + 8 * s);
      ctx.moveTo(sx + 8 * s, sy - 8 * s); ctx.lineTo(sx - 8 * s, sy + 8 * s);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';

    if (hp <= 1 && animFrame % 10 < 5) ctx.globalAlpha = 0.5;
    if (attacking) { ctx.shadowColor = color; ctx.shadowBlur = 15 * s; }

    // 动画：速度决定摆动频率，不再是固定帧率
    const speed = Math.sqrt(velX * velX + velY * velY);
    const walkPhase = moving ? (animFrame * 0.15 * Math.max(speed, 1)) : 0;
    const walkCycle = Math.sin(walkPhase);

    // 身体倾斜：跟随速度方向
    const leanAngle = moving ? Math.atan2(velY, velX) : facing;
    const leanTilt = moving ? Math.min(speed * 0.02, BODY_LEAN_FACTOR) : 0;
    const bodyTiltX = Math.cos(leanAngle) * leanTilt * bodyLen;
    const bodyTiltY = Math.sin(leanAngle) * leanTilt * bodyLen;

    const bodyTop = sy - bodyLen * 0.3;
    const bodyBot = sy + bodyLen * 0.7;
    const topX = sx + bodyTiltX;
    const topY = bodyTop + bodyTiltY;
    const botX = sx - bodyTiltX;
    const botY = bodyBot - bodyTiltY;

    // 身体
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(botX, botY);
    ctx.stroke();

    // 头
    ctx.beginPath();
    ctx.arc(topX, topY - r * 0.7, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    // 手臂
    const armY = topY + bodyLen * 0.3;
    const armCenterX = lerp(topX, botX, 0.3);
    const armSpread = moving ? walkCycle * 0.4 : 0;

    if (attacking) {
      const fX = sx + Math.cos(facing) * limbLen * 1.5;
      const fY = armY + Math.sin(facing) * limbLen * 1.5;
      ctx.beginPath(); ctx.moveTo(armCenterX, armY); ctx.lineTo(fX, fY); ctx.stroke();
      ctx.beginPath(); ctx.arc(fX, fY, 3 * s, 0, Math.PI * 2); ctx.fill();
      const bX = sx - Math.cos(facing) * limbLen * 0.5;
      const bY = armY - Math.sin(facing) * limbLen * 0.5;
      ctx.beginPath(); ctx.moveTo(armCenterX, armY); ctx.lineTo(bX, bY); ctx.stroke();
    } else {
      const a1x = armCenterX + Math.cos(facing + Math.PI / 2 + armSpread) * limbLen;
      const a1y = armY + Math.sin(facing + Math.PI / 2 + armSpread) * limbLen * 0.5;
      const a2x = armCenterX + Math.cos(facing - Math.PI / 2 - armSpread) * limbLen;
      const a2y = armY + Math.sin(facing - Math.PI / 2 - armSpread) * limbLen * 0.5;
      ctx.beginPath(); ctx.moveTo(armCenterX, armY); ctx.lineTo(a1x, a1y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(armCenterX, armY); ctx.lineTo(a2x, a2y); ctx.stroke();
    }

    // 腿：与手臂反相摆动
    const legSpread = moving ? walkCycle * 0.5 : 0;
    const legCenterX = botX;
    const l1x = legCenterX + Math.cos(facing + Math.PI * 0.7 - legSpread) * limbLen;
    const l1y = botY + Math.abs(Math.sin(facing + Math.PI * 0.7 - legSpread)) * limbLen;
    const l2x = legCenterX + Math.cos(facing + Math.PI * 1.3 + legSpread) * limbLen;
    const l2y = botY + Math.abs(Math.sin(facing + Math.PI * 1.3 + legSpread)) * limbLen;
    ctx.beginPath(); ctx.moveTo(legCenterX, botY); ctx.lineTo(l1x, l1y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(legCenterX, botY); ctx.lineTo(l2x, l2y); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // 血条
    const barW = 24 * s;
    const barH = 3 * s;
    const barX = sx - barW / 2;
    const barY = Math.min(topY, topY - r) - 14 * s;
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

  // ============ 地图 ============
  function drawArena() {
    const s = getScale();
    const o = getOffset();

    ctx.fillStyle = '#16213e';
    ctx.fillRect(o.x, o.y, arena.w * s, arena.h * s);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= arena.w; gx += 40) {
      ctx.beginPath(); ctx.moveTo(o.x + gx * s, o.y); ctx.lineTo(o.x + gx * s, o.y + arena.h * s); ctx.stroke();
    }
    for (let gy = 0; gy <= arena.h; gy += 40) {
      ctx.beginPath(); ctx.moveTo(o.x, o.y + gy * s); ctx.lineTo(o.x + arena.w * s, o.y + gy * s); ctx.stroke();
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

  // ============ 粒子绘制 ============
  function drawParticles() {
    const s = getScale();
    const o = getOffset();
    for (const p of particles) {
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.fillRect(o.x + p.x * s - p.size / 2, o.y + p.y * s - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ============ 渲染循环（requestAnimationFrame） ============
  function render() {
    const now = performance.now();
    const rawDt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // 固定步长累加，防止大dt导致多次update
    accumulator += Math.min(rawDt, 0.1);
    while (accumulator >= FIXED_DT) {
      fixedUpdate();
      accumulator -= FIXED_DT;
    }

    animFrame++;
    updateParticles();

    // 屏幕震动
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
      for (const base of gameState) {
        const p = getRenderState(base.slot);
        if (!p) continue;
        // 估算速度方向用于身体倾斜
        const rs = remoteState[base.slot];
        let velX = 0, velY = 0;
        if (base.slot === mySlot) {
          velX = localInputX; velY = localInputY;
        } else if (rs) {
          velX = rs.curX - rs.prevX; velY = rs.curY - rs.prevY;
        }
        drawStickFigure(
          p.x, p.y, p.facing, colors[p.slot],
          p.moving, p.alive, p.attacking, p.hp, p.slot,
          velX, velY
        );
      }
    }

    ctx.restore();
    requestAnimationFrame(render);
  }

  // ============ 虚拟摇杆 ============
  function findTouch(touches) {
    if (joyTouchId === 'mouse') return null;
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === joyTouchId) return touches[i];
    }
    return null;
  }

  function updateJoy(clientX, clientY) {
    const rect = joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOY_RADIUS) { dx = (dx / dist) * JOY_RADIUS; dy = (dy / dist) * JOY_RADIUS; }
    joystickKnob.style.left = (35 + dx) + 'px';
    joystickKnob.style.top = (35 + dy) + 'px';
    joyX = dx / JOY_RADIUS;
    joyY = dy / JOY_RADIUS;
    sendInput(joyX, joyY);
  }

  function handleJoyStart(e) {
    e.preventDefault();
    const touch = e.changedTouches ? e.changedTouches[0] : e;
    joyTouchId = touch.identifier != null ? touch.identifier : 'mouse';
    joyActive = true;
    updateJoy(touch.clientX, touch.clientY);
    window.addEventListener('touchmove', handleJoyMove, { passive: false });
    window.addEventListener('touchend', handleJoyEnd, { passive: false });
    window.addEventListener('touchcancel', handleJoyEnd, { passive: false });
    window.addEventListener('mousemove', handleJoyMove);
    window.addEventListener('mouseup', handleJoyEnd);
  }

  function handleJoyMove(e) {
    if (!joyActive) return;
    e.preventDefault();
    if (e.changedTouches) {
      const touch = findTouch(e.changedTouches);
      if (!touch) return;
      updateJoy(touch.clientX, touch.clientY);
    } else {
      updateJoy(e.clientX, e.clientY);
    }
  }

  function handleJoyEnd(e) {
    if (e.changedTouches && !findTouch(e.changedTouches)) return;
    joyActive = false;
    joyTouchId = null;
    joyX = 0; joyY = 0;
    joystickKnob.style.left = '35px';
    joystickKnob.style.top = '35px';
    sendInput(0, 0);
    window.removeEventListener('touchmove', handleJoyMove);
    window.removeEventListener('touchend', handleJoyEnd);
    window.removeEventListener('touchcancel', handleJoyEnd);
    window.removeEventListener('mousemove', handleJoyMove);
    window.removeEventListener('mouseup', handleJoyEnd);
  }

  joystickBase.addEventListener('touchstart', handleJoyStart, { passive: false });
  joystickBase.addEventListener('mousedown', handleJoyStart);

  attackBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); send({ type: 'attack' }); }, { passive: false });
  attackBtn.addEventListener('click', (e) => { e.preventDefault(); send({ type: 'attack' }); });

  // ============ 键盘 ============
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

  // ============ 加入 ============
  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    joinBtn.disabled = true;
    send({ type: 'join', name });
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

  // ============ 启动 ============
  connect();
  lastFrameTime = performance.now();
  requestAnimationFrame(render);
})();
