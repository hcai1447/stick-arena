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
  const INPUT_SEND_INTERVAL = 33;  // ~30fps
  const CORRECT_SNAP_THRESHOLD = 80;  // 超过此距离直接修正
  const CORRECT_LERP_RATE = 0.15;  // 小偏差每帧修正比例
  const JOY_RADIUS = 50;
  const JOY_DEADZONE = 0.12;

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
  let connected = false;

  // ============ 客户端预测 (仅本地玩家) ============
  const local = {
    x: 0, y: 0,           // 预测位置
    facing: 0,             // 预测朝向
    moving: false,         // 是否在移动
    inputX: 0, inputY: 0,  // 当前输入
    alive: true,
    hp: 5,
    correctingX: 0,        // 平滑修正偏移
    correctingY: 0,
  };

  // 输入序列号
  let inputSeq = 0;
  // 已发送但未被服务器确认的输入队列
  const pendingInputs = [];  // { seq, x, y, facing }

  // ============ 远程玩家插值 (其他玩家) ============
  const interp = {};  // slot -> { prevX, prevY, curX, curY, curFacing, curMoving, curAttacking, t }

  // ============ Canvas 自适应 + DPI ============
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function getViewW() { return window.innerWidth; }
  function getViewH() { return window.innerHeight; }

  // ============ 缩放 ============
  function getScale() {
    return Math.min(getViewW() / arena.w, getViewH() / arena.h);
  }
  function getOffset() {
    const s = getScale();
    return { x: (getViewW() - arena.w * s) / 2, y: (getViewH() - arena.h * s) / 2 };
  }

  // ============ 工具 ============
  function lerp(a, b, t) { return a + (b - a) * Math.min(t, 1); }

  // ============ WebSocket ============
  let inputTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      connected = true;
      statusEl.textContent = '已连接服务器';
      joinBtn.disabled = false;
    };
    ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
    ws.onclose = () => {
      connected = false;
      statusEl.textContent = '连接断开，3秒后重连...';
      setTimeout(connect, 3000);
    };
    ws.onerror = () => { statusEl.textContent = '连接失败'; };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ============ 输入处理 ============
  // 发送输入（带序列号，用于服务器和解）
  function sendInput(x, y) {
    local.inputX = x;
    local.inputY = y;

    // 更新本地预测朝向
    const len = Math.sqrt(x * x + y * y);
    if (len > JOY_DEADZONE) {
      local.facing = Math.atan2(y, x);
      local.moving = true;
    } else {
      local.moving = false;
    }
  }

  // 固定频率向服务器发送输入（独立于渲染帧率）
  function startInputLoop() {
    if (inputTimer) return;
    inputTimer = setInterval(() => {
      if (!connected || mySlot < 0) return;

      const x = local.inputX;
      const y = local.inputY;
      const seq = ++inputSeq;

      send({ type: 'input', x, y, seq });

      // 保存到待确认队列，用于和解
      const len = Math.sqrt(x * x + y * y);
      if (len > JOY_DEADZONE) {
        const normX = (x / len) * PLAYER_SPEED;
        const normY = (y / len) * PLAYER_SPEED;
        pendingInputs.push({ seq, dx: normX, dy: normY });
        // 限制队列长度（约1秒的数据）
        if (pendingInputs.length > 60) pendingInputs.shift();
      }
    }, INPUT_SEND_INTERVAL);
  }

  // ============ 客户端预测 ============
  function predictLocal() {
    if (!local.alive) return;

    const len = Math.sqrt(local.inputX * local.inputX + local.inputY * local.inputY);
    if (len > JOY_DEADZONE) {
      const normX = (local.inputX / len) * PLAYER_SPEED;
      const normY = (local.inputY / len) * PLAYER_SPEED;
      local.x += normX;
      local.y += normY;
      local.facing = Math.atan2(local.inputY, local.inputX);
      local.moving = true;

      // 边界
      local.x = Math.max(12, Math.min(arena.w - 12, local.x));
      local.y = Math.max(12, Math.min(arena.h - 12, local.y));

      // 墙壁
      for (const w of walls) {
        const cx = Math.max(w.x, Math.min(local.x, w.x + w.w));
        const cy = Math.max(w.y, Math.min(local.y, w.y + w.h));
        const dx = local.x - cx;
        const dy = local.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 12 && dist > 0) {
          local.x = cx + (dx / dist) * 12;
          local.y = cy + (dy / dist) * 12;
        }
      }
    } else {
      local.moving = false;
    }

    // 平滑修正
    local.x += local.correctingX;
    local.y += local.correctingY;
    local.correctingX *= 0.85;
    local.correctingY *= 0.85;
    if (Math.abs(local.correctingX) < 0.1) local.correctingX = 0;
    if (Math.abs(local.correctingY) < 0.1) local.correctingY = 0;
  }

  // ============ 服务器和解 ============
  function reconcileWithServer(serverPlayer) {
    if (mySlot < 0) return;

    // 移除已确认的输入
    const ackedSeq = serverPlayer.lastInputSeq || 0;
    while (pendingInputs.length > 0 && pendingInputs[0].seq <= ackedSeq) {
      pendingInputs.shift();
    }

    // 服务器位置是权威基准
    const serverX = serverPlayer.x;
    const serverY = serverPlayer.y;

    // 从服务器位置开始，重放未确认的输入
    let replayX = serverX;
    let replayY = serverY;
    for (const inp of pendingInputs) {
      replayX += inp.dx;
      replayY += inp.dy;
      // 边界
      replayX = Math.max(12, Math.min(arena.w - 12, replayX));
      replayY = Math.max(12, Math.min(arena.h - 12, replayY));
      // 墙壁
      for (const w of walls) {
        const cx = Math.max(w.x, Math.min(replayX, w.x + w.w));
        const cy = Math.max(w.y, Math.min(replayY, w.y + w.h));
        const dx = replayX - cx;
        const dy = replayY - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 12 && dist > 0) {
          replayX = cx + (dx / dist) * 12;
          replayY = cy + (dy / dist) * 12;
        }
      }
    }

    // 比较重放位置和当前预测位置
    const driftX = replayX - local.x;
    const driftY = replayY - local.y;
    const drift = Math.sqrt(driftX * driftX + driftY * driftY);

    if (drift > CORRECT_SNAP_THRESHOLD) {
      // 大偏差：直接修正
      local.x = replayX;
      local.y = replayY;
      local.correctingX = 0;
      local.correctingY = 0;
    } else if (drift > 0.5) {
      // 小偏差：平滑修正
      local.correctingX += driftX * CORRECT_LERP_RATE;
      local.correctingY += driftY * CORRECT_LERP_RATE;
    }

    // 同步服务端权威状态（非位置）
    local.alive = serverPlayer.alive;
    local.hp = serverPlayer.hp;
  }

  // ============ 消息处理 ============
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
        startInputLoop();
        break;

      case 'playerJoined':
        names[msg.slot] = msg.name;
        colors[msg.slot] = msg.color;
        statusEl.textContent = `${msg.name} 加入了 (${msg.playerCount}/4)`;
        break;

      case 'playerLeft':
        statusEl.textContent = `有玩家离开了 (${msg.playerCount}/4)`;
        delete interp[msg.slot];
        break;

      case 'roundStart':
        gameOverEl.style.display = 'none';
        particles = [];
        for (const key in interp) delete interp[key];
        pendingInputs.length = 0;
        inputSeq = 0;
        local.correctingX = 0;
        local.correctingY = 0;
        break;

      case 'state':
        for (const p of msg.players) {
          if (p.name) names[p.slot] = p.name;

          if (p.slot === mySlot) {
            // === 本地玩家：服务器和解 ===
            if (local.x === 0 && local.y === 0 && p.alive) {
              // 首次同步
              local.x = p.x;
              local.y = p.y;
            }
            reconcileWithServer(p);
          } else {
            // === 远程玩家：插值 ===
            if (!interp[p.slot]) {
              interp[p.slot] = {
                prevX: p.x, prevY: p.y,
                curX: p.x, curY: p.y,
                curFacing: p.facing, curMoving: p.moving,
                curAttacking: p.attacking,
                t: 1
              };
            } else {
              const s = interp[p.slot];
              s.prevX = getInterpX(p.slot);
              s.prevY = getInterpY(p.slot);
              s.curX = p.x;
              s.curY = p.y;
              s.curFacing = p.facing;
              s.curMoving = p.moving;
              s.curAttacking = p.attacking;
              s.t = 0;
            }
          }
        }
        gameState = msg.players;
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

  // ============ 插值工具（远程玩家） ============
  function getInterpX(slot) {
    const s = interp[slot];
    if (!s) return 0;
    return lerp(s.prevX, s.curX, s.t);
  }
  function getInterpY(slot) {
    const s = interp[slot];
    if (!s) return 0;
    return lerp(s.prevY, s.curY, s.t);
  }

  // ============ 获取渲染状态 ============
  function getRenderState(slot) {
    if (!gameState) return null;

    if (slot === mySlot) {
      // 本地玩家用预测位置
      const base = gameState.find(p => p.slot === slot);
      return {
        ...(base || {}),
        x: local.x,
        y: local.y,
        facing: local.facing,
        moving: local.moving,
        alive: local.alive,
        hp: local.hp,
      };
    }

    const base = gameState.find(p => p.slot === slot);
    if (!base) return null;
    const s = interp[slot];
    if (!s) return base;
    return {
      ...base,
      x: lerp(s.prevX, s.curX, s.t),
      y: lerp(s.prevY, s.curY, s.t),
      facing: s.curFacing,
      moving: s.curMoving,
      attacking: s.curAttacking,
    };
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

    // 速度决定摆动频率
    const speed = Math.sqrt(velX * velX + velY * velY);
    const walkPhase = moving ? (animFrame * 0.15 * Math.max(speed, 1)) : 0;
    const walkCycle = Math.sin(walkPhase);

    // 身体倾斜
    const leanAngle = moving ? Math.atan2(velY, velX) : facing;
    const leanTilt = moving ? Math.min(speed * 0.02, 0.15) : 0;
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

    // 腿（与手臂反相）
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

  // ============ 渲染循环 ============
  function render() {
    animFrame++;
    updateParticles();

    // 推进远程玩家插值
    for (const slot in interp) {
      const s = interp[slot];
      if (s.t < 1) s.t = Math.min(1, s.t + 0.2);
    }

    // 客户端预测
    predictLocal();

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
    ctx.fillRect(-10, -10, getViewW() + 20, getViewH() + 20);

    drawArena();
    drawParticles();

    if (gameState) {
      for (const base of gameState) {
        const p = getRenderState(base.slot);
        if (!p) continue;

        let velX = 0, velY = 0;
        if (base.slot === mySlot) {
          // 本地玩家用预测速度
          const len = Math.sqrt(local.inputX * local.inputX + local.inputY * local.inputY);
          if (len > JOY_DEADZONE) {
            velX = (local.inputX / len) * PLAYER_SPEED;
            velY = (local.inputY / len) * PLAYER_SPEED;
          }
        } else {
          const st = interp[base.slot];
          if (st) {
            velX = st.curX - st.prevX;
            velY = st.curY - st.prevY;
          }
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
  let joyActive = false;
  let joyTouchId = null;

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

    let nx = dx / JOY_RADIUS;
    let ny = dy / JOY_RADIUS;
    // 死区
    if (Math.sqrt(nx * nx + ny * ny) < JOY_DEADZONE) { nx = 0; ny = 0; }
    sendInput(nx, ny);
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

  // ============ 攻击 ============
  attackBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'attack' });
    attackBtn.style.transform = 'scale(0.85)';
    setTimeout(() => { attackBtn.style.transform = ''; }, 100);
  }, { passive: false });
  attackBtn.addEventListener('click', (e) => {
    e.preventDefault();
    send({ type: 'attack' });
  });

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
  requestAnimationFrame(render);
})();
