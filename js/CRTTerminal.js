// CRTTerminal — drawn on a canvas, used as texture
export class CRTTerminal {
  constructor(width = 1024, height = 1024) {
    this.w = width;
    this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');

    // Terminal state
    this.isOn = false;
    this.bootPhase = 0;       // 0=off, 1=flickering, 2=booting, 3=ready, 4=form, 5=processing, 6=done
    this.bootTimer = 0;
    this.flickerCount = 0;

    // Color palettes
    this.palettes = {
      green: {
        bg: '#0a0d0a', text: '#33ff88', dim: '#1a5a3a',
        cursor: '#33ff88', header: '#88ffcc', flickerRGB: '51, 255, 136',
      },
      orange: {
        bg: '#0d0908', text: '#ffaa33', dim: '#cc8844',
        cursor: '#ffaa33', header: '#ffdd88', flickerRGB: '255, 170, 51',
      },
    };

    // CRT colors (start green)
    this.bgColor = '#0a0d0a';
    this.textColor = '#33ff88';
    this.dimColor = '#1a5a3a';
    this.cursorColor = '#33ff88';
    this.headerColor = '#88ffcc';
    this.flickerRGB = '51, 255, 136';

    // Text state
    this.lines = [];           // { text, color, typed (chars revealed so far) }
    this.typeSpeed = 2;        // chars per frame
    this.lineHeight = 28;
    this.fontSize = 22;
    this.padding = 60;
    this.scrollY = 0;

    // Form state
    this.fields = [
      { key: 'userName',  prompt: 'Your name',                    value: '', active: false },
      { key: 'agentName', prompt: 'Agent name (.agent domain)',   value: '', active: false },
      { key: 'email',     prompt: 'Email address',                value: '', active: false },
      { key: 'type',      prompt: 'Type (individual/org)',        value: '', active: false },
      { key: 'orgName',   prompt: 'Organization name (if org)',   value: '', active: false },
    ];
    this.currentField = -1;
    this.cursorVisible = true;
    this.cursorTimer = 0;
    this.inputActive = false;

    // Completion callback
    this.onComplete = null;

    // Boot sequence text
    this.bootLines = [
      { text: '', color: this.textColor },
      { text: '  ██████╗ ███╗   ███╗██╗   ██╗', color: this.headerColor },
      { text: '  ██╔══██╗████╗ ████║██║   ██║', color: this.headerColor },
      { text: '  ██║  ██║██╔████╔██║██║   ██║', color: this.headerColor },
      { text: '  ██║  ██║██║╚██╔╝██║╚██╗ ██╔╝', color: this.headerColor },
      { text: '  ██████╔╝██║ ╚═╝ ██║ ╚████╔╝ ', color: this.headerColor },
      { text: '  ╚═════╝ ╚═╝     ╚═╝  ╚═══╝  ', color: this.headerColor },
      { text: '', color: this.textColor },
      { text: '  DEPARTMENT OF MACHINE VERIFICATION', color: this.headerColor },
      { text: '  Machine Identity & Registration Terminal v1.0', color: this.dimColor },
      { text: '  ─────────────────────────────────', color: this.dimColor },
      { text: '', color: this.textColor },
      { text: '  Initializing registration terminal...', color: this.textColor },
      { text: '  Connection secure. Ready for input.', color: this.textColor },
      { text: '', color: this.textColor },
    ];

    // Scanline + noise
    this.time = 0;
  }

  setColorScheme(name) {
    const p = this.palettes[name];
    if (!p) return;
    const oldText = this.textColor, oldDim = this.dimColor, oldHeader = this.headerColor;
    this.bgColor = p.bg;
    this.textColor = p.text;
    this.dimColor = p.dim;
    this.cursorColor = p.cursor;
    this.headerColor = p.header;
    this.flickerRGB = p.flickerRGB;
    // Remap colors on existing lines
    const remap = { [oldText]: p.text, [oldDim]: p.dim, [oldHeader]: p.header };
    for (const line of this.lines) {
      if (remap[line.color]) line.color = remap[line.color];
    }
    for (const line of this.bootLines) {
      if (remap[line.color]) line.color = remap[line.color];
    }
  }

  turnOn() {
    if (this.isOn) return;
    this.isOn = true;
    this.bootPhase = 1;
    this.bootTimer = 0;
    this.flickerCount = 0;
  }

  getFormData() {
    const data = {};
    for (const f of this.fields) {
      data[f.key] = f.value;
    }
    return data;
  }

  addFormPrompt() {
    const f = this.fields[this.currentField];
    this.lines.push({ text: `  > ${f.prompt}: `, color: this.textColor, typed: 0 });
  }

  handleKey(key) {
    if (!this.inputActive || this.currentField < 0) return;
    const f = this.fields[this.currentField];

    if (key === 'Enter') {
      // Skip org name if individual
      if (f.key === 'type' && f.value.toLowerCase().startsWith('i')) {
        this.fields[4].value = '—';
      }
      // Finalize current line display
      const lastLine = this.lines[this.lines.length - 1];
      lastLine.fullyTyped = true;

      this.currentField++;

      // Skip orgName if individual
      if (this.currentField === 4 && this.fields[3].value.toLowerCase().startsWith('i')) {
        this.currentField++;
      }

      if (this.currentField >= this.fields.length) {
        this.inputActive = false;
        this.startProcessing();
      } else {
        this.fields[this.currentField].active = true;
        this.addFormPrompt();
      }
    } else if (key === 'Backspace') {
      f.value = f.value.slice(0, -1);
    } else if (key.length === 1) {
      f.value += key;
    }
  }

  startProcessing() {
    this.bootPhase = 5;
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    this.lines.push({ text: '  Processing registration...', color: this.textColor, typed: 0 });
    this.processProgress = 0;
  }

  update() {
    this.time++;
    this.cursorTimer++;
    if (this.cursorTimer % 30 === 0) this.cursorVisible = !this.cursorVisible;

    // Boot sequence state machine
    if (this.bootPhase === 1) {
      // Flicker on/off
      this.bootTimer++;
      if (this.bootTimer % 4 === 0) this.flickerCount++;
      if (this.flickerCount > 8) {
        this.bootPhase = 2;
        this.bootTimer = 0;
        // Start adding boot lines
        this.lines = [];
        this.bootLineIndex = 0;
      }
    } else if (this.bootPhase === 2) {
      // Typing boot text
      this.bootTimer++;
      if (this.bootTimer % 3 === 0 && this.bootLineIndex < this.bootLines.length) {
        const bl = this.bootLines[this.bootLineIndex];
        this.lines.push({ text: bl.text, color: bl.color, typed: 0 });
        this.bootLineIndex++;
      }
      // Check if all boot lines added and typed
      const allTyped = this.lines.length >= this.bootLines.length &&
        this.lines.every(l => l.typed >= l.text.length);
      if (allTyped) {
        this.bootPhase = 4;
        this.currentField = 0;
        this.fields[0].active = true;
        this.inputActive = true;
        this.addFormPrompt();
      }
    } else if (this.bootPhase === 5) {
      // Processing animation
      this.processProgress = Math.min((this.processProgress || 0) + 0.8, 100);
      if (this.processProgress >= 100) {
        this.bootPhase = 6;
        this.lines.push({ text: '  ████████████████████████ 100%', color: this.headerColor, typed: 0 });
        this.lines.push({ text: '', color: this.textColor, typed: 999 });
        this.lines.push({ text: '  ✓ IDENTITY CERTIFICATE ISSUED', color: this.headerColor, typed: 0 });
        const serial = 'DMV-' + new Date().getFullYear() + '-' +
          String(Math.floor(Math.random() * 99999)).padStart(5, '0');
        this.lines.push({ text: `  Serial: ${serial}`, color: this.dimColor, typed: 0 });
        this.lines.push({ text: `  Agent: ${this.fields[1].value}.agent`, color: this.textColor, typed: 0 });
        this.lines.push({ text: `  Registered to: ${this.fields[0].value}`, color: this.textColor, typed: 0 });
        this.lines.push({ text: '', color: this.textColor, typed: 999 });
        this.lines.push({ text: '  Certificate will be delivered to:', color: this.dimColor, typed: 0 });
        this.lines.push({ text: `  ${this.fields[2].value}`, color: this.textColor, typed: 0 });

        // Fire completion callback
        if (this.onComplete) {
          this.onComplete(this.getFormData());
        }
      }
    }

    // Advance typing on all lines
    for (const line of this.lines) {
      if (line.typed < line.text.length) {
        line.typed = Math.min(line.typed + this.typeSpeed, line.text.length);
      }
    }

    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    // Background
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    if (!this.isOn) return;

    // Flicker phase — random on/off
    if (this.bootPhase === 1) {
      if (this.flickerCount % 2 === 0) {
        // Screen briefly white-green flash
        ctx.fillStyle = `rgba(${this.flickerRGB}, 0.03)`;
        ctx.fillRect(0, 0, w, h);
      }
      // Occasional bright flash
      if (Math.random() > 0.6) {
        ctx.fillStyle = `rgba(${this.flickerRGB}, ${Math.random() * 0.15})`;
        ctx.fillRect(0, 0, w, h);
      }
      this.drawScanlines(ctx, w, h);
      return;
    }

    // Subtle background glow
    const grad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w * 0.7);
    grad.addColorStop(0, `rgba(${this.flickerRGB}, 0.03)`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Draw text lines
    ctx.font = `${this.fontSize}px "Courier New", monospace`;
    ctx.textBaseline = 'top';

    // Auto-scroll: if content exceeds canvas, scroll to bottom
    const totalHeight = this.lines.length * this.lineHeight + this.padding * 2;
    const maxScroll = Math.max(0, totalHeight - h + 40);
    this.scrollY += (maxScroll - this.scrollY) * 0.1;

    let y = this.padding - this.scrollY;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const displayText = line.text.substring(0, line.typed);

      if (y > -this.lineHeight && y < h) {
        // Glow effect — draw text twice
        ctx.shadowColor = line.color;
        ctx.shadowBlur = 4;
        ctx.fillStyle = line.color;
        ctx.fillText(displayText, this.padding, y);
        ctx.shadowBlur = 0;
      }

      // If this is the active input line, draw the input value + cursor
      if (this.inputActive && i === this.lines.length - 1 &&
          this.currentField >= 0 && this.currentField < this.fields.length) {
        const f = this.fields[this.currentField];
        const promptWidth = ctx.measureText(displayText).width;
        const inputText = f.value;
        ctx.fillStyle = this.textColor;
        ctx.shadowColor = this.textColor;
        ctx.shadowBlur = 4;
        ctx.fillText(inputText, this.padding + promptWidth, y);
        ctx.shadowBlur = 0;

        // Blinking cursor
        if (this.cursorVisible) {
          const cursorX = this.padding + promptWidth + ctx.measureText(inputText).width;
          ctx.fillStyle = this.cursorColor;
          ctx.fillRect(cursorX + 2, y + 2, this.fontSize * 0.55, this.fontSize - 2);
        }
      }

      y += this.lineHeight;
    }

    // Processing bar
    if (this.bootPhase === 5 && this.processProgress < 100) {
      const barY = y;
      const barWidth = (w - this.padding * 2) * 0.6;
      const filled = barWidth * (this.processProgress / 100);
      ctx.fillStyle = this.dimColor;
      ctx.fillRect(this.padding + 16, barY, barWidth, this.lineHeight - 8);
      ctx.fillStyle = this.headerColor;
      ctx.fillRect(this.padding + 16, barY, filled, this.lineHeight - 8);
      ctx.fillStyle = this.textColor;
      ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
      ctx.fillText(`  ${Math.floor(this.processProgress)}%`, this.padding + barWidth + 24, barY + 2);
      ctx.font = `${this.fontSize}px "Courier New", monospace`;
    }

    // CRT effects
    this.drawScanlines(ctx, w, h);
    this.drawVignette(ctx, w, h);

    // Random noise flicker
    if (Math.random() > 0.97) {
      ctx.fillStyle = `rgba(${this.flickerRGB}, ${Math.random() * 0.02})`;
      ctx.fillRect(0, Math.random() * h, w, 2);
    }
  }

  drawScanlines(ctx, w, h) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
    // Rolling scanline
    const rollY = (this.time * 1.5) % (h + 100) - 50;
    ctx.fillStyle = `rgba(${this.flickerRGB}, 0.03)`;
    ctx.fillRect(0, rollY, w, 40);
  }

  drawVignette(ctx, w, h) {
    const grad = ctx.createRadialGradient(w/2, h/2, w * 0.25, w/2, h/2, w * 0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}
