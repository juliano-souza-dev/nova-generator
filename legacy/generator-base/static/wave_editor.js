(() => {
  const isTyping = (target) => {
    const tag = target?.tagName?.toLowerCase?.();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
  };

  const stepFromEvent = (event) => event.altKey ? 1 : (event.shiftKey ? 100 : 10);

  const editors = new Set();
  let activeEditor = null;
  let globalShortcutsBound = false;

  const activateEditor = (editor) => {
    if (!editor) return;
    activeEditor = editor;
    for (const item of editors) item.stage?.toggleAttribute?.('data-wave-active', item === editor);
  };

  const shortcutHandled = (editor, event) => {
    if (!editor || isTyping(event.target)) return false;
    if (typeof editor.handleShortcut === 'function') {
      try {
        if (editor.handleShortcut(event, stepFromEvent)) return true;
      } catch (error) { editor.onError?.(error); return true; }
    }
    if (event.code === 'Space') {
      if (event.shiftKey && typeof editor.toggleFullPlayback === 'function') editor.toggleFullPlayback();
      else editor.toggleSelectionPlayback();
      return true;
    }
    const key = String(event.key || '').toLowerCase();
    if (key === 'a') {
      try { editor.setInFromPlayhead(); } catch (error) { editor.onError(error); }
      return true;
    }
    if (key === 's') {
      try { editor.setOutFromPlayhead(); } catch (error) { editor.onError(error); }
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      try { editor.nudge(direction * stepFromEvent(event)); } catch (error) { editor.onError(error); }
      return true;
    }
    return false;
  };

  const ensureGlobalShortcuts = () => {
    if (globalShortcutsBound || typeof document === 'undefined') return;
    globalShortcutsBound = true;
    document.addEventListener('keydown', (event) => {
      const editor = activeEditor || editors.values().next().value || null;
      if (!shortcutHandled(editor, event)) return;
      event.preventDefault();
    });
  };

  const formatMs = (value) => {
    let ms = Math.max(0, Math.round(Number(value) || 0));
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000); ms %= 60000;
    const s = Math.floor(ms / 1000); const milli = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  };

  const parseMs = (value) => {
    const text = String(value ?? '').trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000));
    const match = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) throw new Error('Use HH:MM:SS.mmm.');
    const [, h, m, s, raw = '0'] = match;
    if (Number(m) > 59 || Number(s) > 59) throw new Error('Timecode inválido.');
    return ((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000) + Number(raw.padEnd(3, '0'));
  };

  class RangeEditor {
    constructor(options = {}) {
      this.stage = options.stage;
      this.canvas = options.canvas;
      this.video = options.video;
      this.startInput = options.startInput;
      this.endInput = options.endInput;
      this.startLabel = options.startLabel || null;
      this.endLabel = options.endLabel || null;
      this.durationLabel = options.durationLabel || null;
      this.peaks = Array.isArray(options.peaks) ? options.peaks : [];
      this.durationMs = Math.max(1, Number(options.durationMs) || 1);
      this.activeField = options.activeField === 'end' ? 'end' : 'start';
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.onActivate = typeof options.onActivate === 'function' ? options.onActivate : () => {};
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.handleHitRadius = Math.max(14, Number(options.handleHitRadius) || 14);
      this.accent = String(options.accent || '').trim();
      this.lineColor = String(options.lineColor || '').trim();
      this.maxZoom = Math.max(8, Number(options.maxZoom) || 8);
      this.zoom = Math.max(1, Math.min(this.maxZoom, Number(options.zoom) || 1));
      this.viewStartMs = 0;
      this.dragging = '';
      this.playToken = 0;
      this.raf = null;
      editors.add(this);
      if (!activeEditor) activeEditor = this;
      ensureGlobalShortcuts();
      this._bind();
      this.draw();
    }

    setData({ peaks, durationMs } = {}) {
      if (Array.isArray(peaks)) this.peaks = peaks;
      if (Number(durationMs) > 0) this.durationMs = Number(durationMs);
      this._clampViewStart();
      this.draw();
    }

    _viewWindow() {
      const total = Math.max(1, this.durationMs);
      if (this.zoom <= 1) return { start: 0, end: total, size: total };
      const size = Math.max(1, total / this.zoom);
      this._clampViewStart(size);
      return { start: this.viewStartMs, end: Math.min(total, this.viewStartMs + size), size };
    }

    _clampViewStart(windowSize = Math.max(1, this.durationMs / Math.max(1, this.zoom))) {
      const maxStart = Math.max(0, this.durationMs - windowSize);
      this.viewStartMs = Math.max(0, Math.min(maxStart, Number(this.viewStartMs) || 0));
    }

    setZoom(value, { centerMs = null } = {}) {
      const oldWindow = this._viewWindow();
      const center = Number.isFinite(Number(centerMs)) ? Number(centerMs) : (oldWindow.start + oldWindow.size / 2);
      this.zoom = Math.max(1, Math.min(this.maxZoom, Number(value) || 1));
      const size = Math.max(1, this.durationMs / this.zoom);
      this.viewStartMs = this.zoom <= 1 ? 0 : center - size / 2;
      this._clampViewStart(size);
      this.draw();
      return this.zoom;
    }

    centerOnRange() {
      const range = this.getRange();
      const middle = (range.start + range.end) / 2;
      const size = Math.max(1, this.durationMs / Math.max(1, this.zoom));
      this.viewStartMs = this.zoom <= 1 ? 0 : middle - size / 2;
      this._clampViewStart(size);
      this.draw();
    }

    pan(deltaMs) {
      if (this.zoom <= 1) return;
      const size = Math.max(1, this.durationMs / this.zoom);
      this.viewStartMs += Number(deltaMs) || 0;
      this._clampViewStart(size);
      this.draw();
    }

    setRange(start, end, { silent = false } = {}) {
      const total = Math.max(1, this.durationMs);
      let a = Math.max(0, Math.min(total - 1, Math.round(Number(start) || 0)));
      let b = Math.max(a + 1, Math.min(total, Math.round(Number(end) || a + 1)));
      this.startInput.value = formatMs(a);
      this.endInput.value = formatMs(b);
      this._syncLabels(a, b);
      this.draw();
      if (!silent) this.onChange({ start: a, end: b, field: this.activeField });
      return { start: a, end: b };
    }

    getRange() {
      const start = parseMs(this.startInput.value);
      const end = parseMs(this.endInput.value);
      if (end <= start) throw new Error('OUT precisa ser maior que IN.');
      return { start, end };
    }

    activate() {
      activateEditor(this);
      this.onActivate();
    }

    setActiveField(field) {
      this.activate();
      this.activeField = field === 'end' ? 'end' : 'start';
      this.stage?.setAttribute('data-active-handle', this.activeField);
    }

    nudge(deltaMs) {
      const range = this.getRange();
      const total = Math.max(1, this.durationMs);
      if (this.activeField === 'end') {
        range.end = Math.max(range.start + 1, Math.min(total, range.end + Number(deltaMs || 0)));
      } else {
        range.start = Math.max(0, Math.min(range.end - 1, range.start + Number(deltaMs || 0)));
      }
      this.setRange(range.start, range.end);
      this._seekBoundary(this.activeField === 'end' ? range.end : range.start);
    }

    setInFromPlayhead() {
      const current = Math.round((Number(this.video?.currentTime) || 0) * 1000);
      const range = this.getRange();
      this.setActiveField('start');
      this.setRange(Math.min(current, range.end - 1), range.end);
    }

    setOutFromPlayhead() {
      const current = Math.round((Number(this.video?.currentTime) || 0) * 1000);
      const range = this.getRange();
      this.setActiveField('end');
      this.setRange(range.start, Math.max(range.start + 1, current));
    }

    async playSelection() {
      const { start, end } = this.getRange();
      const video = this.video;
      if (!video) return;
      const token = ++this.playToken;
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      video.pause();
      video.currentTime = start / 1000;
      try { await video.play(); } catch (_) { return; }
      const guard = () => {
        if (token !== this.playToken) return;
        if ((Number(video.currentTime) || 0) * 1000 >= end - 8 || video.ended) {
          video.pause();
          try { video.currentTime = start / 1000; } catch (_) {}
          this.draw();
          return;
        }
        this.draw();
        this.raf = requestAnimationFrame(guard);
      };
      this.raf = requestAnimationFrame(guard);
    }

    cancelPlayback() {
      this.playToken++;
      if (this.raf !== null) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      this.video?.pause();
    }

    toggleSelectionPlayback() {
      if (!this.video) return;
      if (!this.video.paused) {
        this.cancelPlayback();
        return;
      }
      this.playSelection().catch(this.onError);
    }

    async playFullArea() {
      const video = this.video;
      if (!video) return;
      const token = ++this.playToken;
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      video.pause();
      const resumeAt = Math.max(0, Math.min(this.durationMs / 1000, Number(video.currentTime) || 0));
      video.currentTime = resumeAt;
      try { await video.play(); } catch (_) { return; }
      const guard = () => {
        if (token !== this.playToken) return;
        if ((Number(video.currentTime) || 0) * 1000 >= this.durationMs - 8 || video.ended) {
          video.pause();
          try { video.currentTime = resumeAt; } catch (_) {}
          this.draw();
          return;
        }
        this.draw();
        this.raf = requestAnimationFrame(guard);
      };
      this.raf = requestAnimationFrame(guard);
    }

    toggleFullPlayback() {
      if (!this.video) return;
      if (!this.video.paused) {
        this.cancelPlayback();
        return;
      }
      this.playFullArea().catch(this.onError);
    }

    _syncLabels(start, end) {
      if (this.startLabel) this.startLabel.textContent = formatMs(start);
      if (this.endLabel) this.endLabel.textContent = formatMs(end);
      if (this.durationLabel) this.durationLabel.textContent = `${((end - start) / 1000).toFixed(3)}s`;
    }

    _pointMs(event) {
      const rect = this.stage.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const view = this._viewWindow();
      return Math.round(view.start + (x / Math.max(1, rect.width)) * view.size);
    }

    _handleAt(event) {
      const rect = this.stage.getBoundingClientRect();
      const range = this.getRange();
      const x = event.clientX - rect.left;
      const view = this._viewWindow();
      const sx = ((range.start - view.start) / view.size) * rect.width;
      const ex = ((range.end - view.start) / view.size) * rect.width;
      if (Math.abs(x - sx) <= this.handleHitRadius) return 'start';
      if (Math.abs(x - ex) <= this.handleHitRadius) return 'end';
      return '';
    }

    _seekBoundary(ms, { cancel = true } = {}) {
      if (!this.video) return;
      if (cancel) this.cancelPlayback();
      try { this.video.currentTime = Math.max(0, Math.min(this.durationMs, Number(ms) || 0)) / 1000; } catch (_) {}
      this.draw();
    }

    _bind() {
      if (!this.stage || !this.canvas || !this.startInput || !this.endInput) return;
      this.stage.classList.add('wave-editor-stage');
      this.stage.tabIndex = this.stage.tabIndex >= 0 ? this.stage.tabIndex : 0;

      this.startInput.addEventListener('focus', () => this.setActiveField('start'));
      this.endInput.addEventListener('focus', () => this.setActiveField('end'));
      this.video?.addEventListener('pointerdown', () => this.activate());
      for (const [input, field] of [[this.startInput, 'start'], [this.endInput, 'end']]) {
        input.addEventListener('change', () => {
          try {
            const range = this.getRange();
            this.setRange(range.start, range.end);
            this._seekBoundary(field === 'end' ? range.end : range.start);
          } catch (error) { this.onError(error); }
        });
      }

      this.stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        this.activate();
        const hit = this._handleAt(event);
        if (hit) {
          this.dragging = hit;
          this.setActiveField(hit);
          const range = this.getRange();
          this._seekBoundary(hit === 'end' ? range.end : range.start);
          this.stage.setPointerCapture?.(event.pointerId);
          event.preventDefault();
          return;
        }
        const ms = this._pointMs(event);
        if (this.video) this.video.currentTime = ms / 1000;
        this.draw();
      });

      this.stage.addEventListener('pointermove', (event) => {
        if (!this.dragging) return;
        try {
          const ms = this._pointMs(event);
          const range = this.getRange();
          if (this.dragging === 'start') {
            const next = Math.min(ms, range.end - 1);
            this.setRange(next, range.end);
            this._seekBoundary(next, {cancel:false});
          } else {
            const next = Math.max(range.start + 1, ms);
            this.setRange(range.start, next);
            this._seekBoundary(next, {cancel:false});
          }
        } catch (error) { this.onError(error); }
      });

      const endDrag = (event) => {
        if (!this.dragging) return;
        this.dragging = '';
        try { this.stage.releasePointerCapture?.(event.pointerId); } catch (_) {}
      };
      this.stage.addEventListener('pointerup', endDrag);
      this.stage.addEventListener('pointercancel', endDrag);
      this.stage.addEventListener('wheel', (event) => {
        if (this.zoom <= 1) return;
        event.preventDefault();
        const view = this._viewWindow();
        const direction = (event.deltaY || event.deltaX) > 0 ? 1 : -1;
        this.pan(direction * view.size * 0.12);
      }, { passive: false });

      // Keyboard shortcuts are intentionally bound once at document level.
      // The last interacted Wave Editor becomes the global active editor.


      this.video?.addEventListener('timeupdate', () => this.draw());
      this.video?.addEventListener('seeked', () => this.draw());
      window.addEventListener('resize', () => this.draw());
    }

    draw() {
      if (!this.canvas || !this.stage) return;
      const rect = this.stage.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const height = Math.max(92, Number(this.stage.dataset.waveHeight) || 112);
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${height}px`;
      const ctx = this.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const styles = getComputedStyle(this.stage);
      const accent = this.accent || styles.getPropertyValue('--wave-accent').trim() || '#38e5a5';
      const bg = styles.getPropertyValue('--wave-bg').trim() || '#07100c';
      const line = this.lineColor || styles.getPropertyValue('--wave-line').trim() || '#355346';
      ctx.clearRect(0, 0, rect.width, height);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, rect.width, height);
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      for (let i = 1; i < 6; i++) {
        const x = rect.width * i / 6;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      const peaks = this.peaks || [];
      const view = this._viewWindow();
      const mid = height / 2;
      ctx.strokeStyle = line;
      ctx.globalAlpha = .9;
      ctx.beginPath();
      for (let x = 0; x < rect.width; x++) {
        const timeMs = view.start + (x / Math.max(1, rect.width)) * view.size;
        const index = Math.max(0, Math.min(peaks.length - 1, Math.floor((timeMs / this.durationMs) * peaks.length)));
        const amp = Number(peaks[index] || 0) * (height * .39);
        ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      let range = { start: 0, end: Math.min(this.durationMs, 1000) };
      try { range = this.getRange(); } catch (_) {}
      const sx = ((range.start - view.start) / view.size) * rect.width;
      const ex = ((range.end - view.start) / view.size) * rect.width;
      const visibleStartX = Math.max(0, Math.min(rect.width, sx));
      const visibleEndX = Math.max(0, Math.min(rect.width, ex));
      if (visibleEndX > visibleStartX) {
        ctx.save();
        ctx.globalAlpha = .14;
        ctx.fillStyle = accent;
        ctx.fillRect(visibleStartX, 0, Math.max(1, visibleEndX - visibleStartX), height);
        ctx.restore();
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      for (const x of [sx, ex]) {
        if (x < 0 || x > rect.width) continue;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }

      // Global Wave Editor contract: every instance exposes visible, draggable IN/OUT selectors.
      const drawSelector = (x, label, selected) => {
        const width = 34;
        const tabX = Math.max(1, Math.min(rect.width - width - 1, x - width / 2));
        ctx.save();
        ctx.fillStyle = selected ? accent : '#0d241a';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(tabX, 5, width, 20, 5);
        else ctx.rect(tabX, 5, width, 20);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = selected ? '#04110b' : accent;
        ctx.font = '700 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tabX + width / 2, 15);
        ctx.restore();
      };
      if (sx >= 0 && sx <= rect.width) drawSelector(sx, 'IN', this.activeField === 'start');
      if (ex >= 0 && ex <= rect.width) drawSelector(ex, 'OUT', this.activeField === 'end');

      const playMs = (Number(this.video?.currentTime) || 0) * 1000;
      if (playMs >= view.start && playMs <= view.end) {
        const px = ((playMs - view.start) / view.size) * rect.width;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke();
      }
      this._syncLabels(range.start, range.end);
    }
  }



  class MarkerEditor {
    constructor(options = {}) {
      this.stage = options.stage;
      this.canvas = options.canvas;
      this.video = options.video;
      this.peaks = Array.isArray(options.peaks) ? options.peaks : [];
      this.durationMs = Math.max(1, Number(options.durationMs) || 1);
      this.markers = [];
      this.endMs = null;
      this.selectedType = '';
      this.selectedIndex = -1;
      this.zoom = Math.max(1, Math.min(8, Number(options.zoom) || 1));
      this.viewStartMs = 0;
      this.dragging = false;
      this.dragDirty = false;
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.onCommit = typeof options.onCommit === 'function' ? options.onCommit : () => {};
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.accent = String(options.accent || '').trim();
      this.endColor = String(options.endColor || '#ffb866').trim();
      this.lineColor = String(options.lineColor || '').trim();
      editors.add(this);
      if (!activeEditor) activeEditor = this;
      ensureGlobalShortcuts();
      this.setMarkers(options.markers || [], options.endMs ?? null, {silent:true});
      this._bind();
      this.draw();
    }

    activate() { activateEditor(this); }
    setData({peaks, durationMs} = {}) {
      if (Array.isArray(peaks)) this.peaks = peaks;
      if (Number(durationMs) > 0) this.durationMs = Number(durationMs);
      this._clampViewStart();
      this.setMarkers(this.markers, this.endMs, {silent:true});
      this.draw();
    }
    _viewWindow() {
      const total = Math.max(1, this.durationMs);
      if (this.zoom <= 1) return {start:0,end:total,size:total};
      const size = Math.max(1, total / this.zoom);
      this._clampViewStart(size);
      return {start:this.viewStartMs,end:Math.min(total,this.viewStartMs+size),size};
    }
    _clampViewStart(windowSize = Math.max(1, this.durationMs / Math.max(1, this.zoom))) {
      const maxStart = Math.max(0, this.durationMs - windowSize);
      this.viewStartMs = Math.max(0, Math.min(maxStart, Number(this.viewStartMs) || 0));
    }
    setZoom(value, {centerMs=null} = {}) {
      const old = this._viewWindow();
      const center = Number.isFinite(Number(centerMs)) ? Number(centerMs) : old.start + old.size / 2;
      this.zoom = Math.max(1, Math.min(8, Number(value) || 1));
      const size = Math.max(1, this.durationMs / this.zoom);
      this.viewStartMs = this.zoom <= 1 ? 0 : center - size/2;
      this._clampViewStart(size);
      this.draw();
      return this.zoom;
    }
    centerOnCurrentBlock() {
      const start = this.currentBlockStart();
      const end = this.endMs ?? this.durationMs;
      const marker = this.selectedType === 'pause' && this.selectedIndex >= 0 ? this.markers[this.selectedIndex] : (this.selectedType === 'end' ? this.endMs : Math.min(end, start + Math.max(1000,(end-start)/2)));
      const center = (start + Number(marker || end)) / 2;
      const size = Math.max(1, this.durationMs / Math.max(1,this.zoom));
      this.viewStartMs = this.zoom <= 1 ? 0 : center - size/2;
      this._clampViewStart(size);
      this.draw();
    }
    pan(deltaMs) {
      if (this.zoom <= 1) return;
      const size = Math.max(1, this.durationMs / this.zoom);
      this.viewStartMs += Number(deltaMs) || 0;
      this._clampViewStart(size);
      this.draw();
    }
    currentBlockStart() { return this.markers.length ? this.markers[this.markers.length - 1] : 0; }
    setMarkers(markers, endMs=null, {silent=false} = {}) {
      const total = this.durationMs;
      const terminal = endMs == null ? total : Math.max(1, Math.min(total, Math.round(Number(endMs)||0)));
      const values = [...new Set((Array.isArray(markers)?markers:[]).map(v=>Math.round(Number(v)||0)).filter(v=>v>0 && v<terminal))].sort((a,b)=>a-b);
      this.markers = values;
      this.endMs = endMs == null ? null : terminal;
      if (this.selectedType === 'pause' && (this.selectedIndex < 0 || this.selectedIndex >= this.markers.length)) { this.selectedType=''; this.selectedIndex=-1; }
      if (this.selectedType === 'end' && this.endMs == null) { this.selectedType=''; this.selectedIndex=-1; }
      this.draw();
      if (!silent) this.onChange(this.getState());
      return this.getState();
    }
    getState() { return {markers:[...this.markers], endMs:this.endMs, selectedType:this.selectedType, selectedIndex:this.selectedIndex}; }
    selectPause(index) { if(index<0||index>=this.markers.length)return; this.selectedType='pause'; this.selectedIndex=index; this.activate(); this.draw(); }
    selectEnd() { if(this.endMs==null)return; this.selectedType='end'; this.selectedIndex=-1; this.activate(); this.draw(); }
    clearSelection() { this.selectedType=''; this.selectedIndex=-1; this.draw(); }
    addPause(ms) {
      if (this.endMs != null) throw new Error('Remova o END ou use vídeo todo antes de criar outro bloco.');
      const value = Math.round(Number(ms)||0);
      const start = this.currentBlockStart();
      if (value <= start) throw new Error('PAUSA precisa ficar depois do início do bloco atual.');
      if (value >= this.durationMs) throw new Error('No fim da mídia, use o vídeo completo como término do último bloco.');
      this.markers.push(value); this.markers.sort((a,b)=>a-b);
      this.selectedType='pause'; this.selectedIndex=this.markers.indexOf(value);
      this.draw(); this.onChange(this.getState()); this.onCommit(this.getState());
    }
    addPauseAtPlayhead() { this.addPause(Math.round((Number(this.video?.currentTime)||0)*1000)); }
    setEnd(ms) {
      const value = Math.round(Number(ms)||0);
      const start = this.currentBlockStart();
      if (value <= start) throw new Error('END só pode ser marcado depois do início do bloco atual.');
      if (value > this.durationMs) throw new Error('END precisa ficar dentro da mídia.');
      this.endMs=value; this.selectedType='end'; this.selectedIndex=-1;
      this.draw(); this.onChange(this.getState()); this.onCommit(this.getState());
    }
    setEndFromPlayhead() { this.setEnd(Math.round((Number(this.video?.currentTime)||0)*1000)); }
    useFullVideo() {
      this.endMs=null;
      if(this.selectedType==='end'){this.selectedType='';this.selectedIndex=-1;}
      this.draw(); this.onChange(this.getState()); this.onCommit(this.getState());
    }
    removeSelected() {
      if(this.selectedType==='pause' && this.selectedIndex>=0){
        this.markers.splice(this.selectedIndex,1); this.selectedType=''; this.selectedIndex=-1;
      } else if(this.selectedType==='end') { this.endMs=null; this.selectedType=''; this.selectedIndex=-1; }
      else return false;
      this.draw(); this.onChange(this.getState()); this.onCommit(this.getState()); return true;
    }
    _nudgeSelected(deltaMs) {
      const delta = Number(deltaMs)||0;
      if(this.selectedType==='pause' && this.selectedIndex>=0){
        const i=this.selectedIndex;
        const min=(i>0?this.markers[i-1]:0)+1;
        const max=((i+1<this.markers.length)?this.markers[i+1]:(this.endMs??this.durationMs))-1;
        this.markers[i]=Math.max(min,Math.min(max,this.markers[i]+delta));
      } else if(this.selectedType==='end' && this.endMs!=null){
        const min=this.currentBlockStart()+1;
        this.endMs=Math.max(min,Math.min(this.durationMs,this.endMs+delta));
      } else {
        if(this.video) this.video.currentTime=Math.max(0,Math.min(this.durationMs/1000,(Number(this.video.currentTime)||0)+delta/1000));
      }
      this.draw(); this.onChange(this.getState());
    }
    async togglePlayback() {
      if(!this.video)return;
      if(!this.video.paused){this.video.pause();return;}
      try{await this.video.play();}catch(_){}
    }
    async toggleFullPlayback() {
      if(!this.video)return;
      if(!this.video.paused){this.video.pause();return;}
      try{await this.video.play();}catch(_){}
    }
    handleShortcut(event, stepFn) {
      if(event.code==='Space'&&event.shiftKey){this.toggleFullPlayback();return true;}
      if(event.code==='Space'){this.togglePlayback();return true;}
      const key=String(event.key||'').toLowerCase();
      if(key==='a'){this.addPauseAtPlayhead();return true;}
      if(key==='e'){this.setEndFromPlayhead();return true;}
      if(event.key==='Delete'||event.key==='Backspace'){return this.removeSelected();}
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        const direction=event.key==='ArrowRight'?1:-1;
        this._nudgeSelected(direction*(typeof stepFn==='function'?stepFn(event):stepFromEvent(event)));
        if(this.selectedType) this.onCommit(this.getState());
        return true;
      }
      return false;
    }
    _pointMs(event){const rect=this.stage.getBoundingClientRect();const x=Math.max(0,Math.min(rect.width,event.clientX-rect.left));const view=this._viewWindow();return Math.round(view.start+(x/Math.max(1,rect.width))*view.size);}
    _markerHit(event){
      const rect=this.stage.getBoundingClientRect();const x=event.clientX-rect.left;const view=this._viewWindow();let best=null;
      this.markers.forEach((ms,i)=>{const px=((ms-view.start)/view.size)*rect.width;const d=Math.abs(x-px);if(d<=14&&(!best||d<best.d))best={type:'pause',index:i,d};});
      if(this.endMs!=null){const px=((this.endMs-view.start)/view.size)*rect.width;const d=Math.abs(x-px);if(d<=14&&(!best||d<best.d))best={type:'end',index:-1,d};}
      return best;
    }
    _dragValue(ms){
      if(this.selectedType==='pause'){
        const i=this.selectedIndex;const min=(i>0?this.markers[i-1]:0)+1;const max=((i+1<this.markers.length)?this.markers[i+1]:(this.endMs??this.durationMs))-1;return Math.max(min,Math.min(max,ms));
      }
      if(this.selectedType==='end'){return Math.max(this.currentBlockStart()+1,Math.min(this.durationMs,ms));}
      return ms;
    }
    _bind(){
      if(!this.stage||!this.canvas)return;
      this.stage.classList.add('wave-editor-stage','marker-editor-stage');this.stage.tabIndex=this.stage.tabIndex>=0?this.stage.tabIndex:0;
      this.video?.addEventListener('pointerdown',()=>this.activate());
      this.stage.addEventListener('pointerdown',(event)=>{
        if(event.button!==0)return;this.activate();const hit=this._markerHit(event);
        if(hit){event.preventDefault();this.selectedType=hit.type;this.selectedIndex=hit.index;this.dragging=true;this.dragDirty=false;this.stage.setPointerCapture?.(event.pointerId);this.draw();return;}
        this.clearSelection();const ms=this._pointMs(event);if(this.video)this.video.currentTime=ms/1000;this.draw();
      });
      this.stage.addEventListener('pointermove',(event)=>{
        if(!this.dragging)return;event.preventDefault();const value=this._dragValue(this._pointMs(event));
        if(this.selectedType==='pause'&&this.selectedIndex>=0){if(this.markers[this.selectedIndex]!==value){this.markers[this.selectedIndex]=value;this.dragDirty=true;}}
        else if(this.selectedType==='end'&&this.endMs!==value){this.endMs=value;this.dragDirty=true;}
        if(this.video)this.video.currentTime=value/1000;this.draw();this.onChange(this.getState());
      });
      const endDrag=(event)=>{if(!this.dragging)return;this.dragging=false;try{this.stage.releasePointerCapture?.(event.pointerId);}catch(_){}if(this.dragDirty){this.dragDirty=false;this.onCommit(this.getState());}};
      this.stage.addEventListener('pointerup',endDrag);this.stage.addEventListener('pointercancel',endDrag);
      this.stage.addEventListener('wheel',(event)=>{if(this.zoom<=1)return;event.preventDefault();const view=this._viewWindow();const direction=(event.deltaY||event.deltaX)>0?1:-1;this.pan(direction*view.size*.12);},{passive:false});
      this.video?.addEventListener('timeupdate',()=>this.draw());this.video?.addEventListener('seeked',()=>this.draw());window.addEventListener('resize',()=>this.draw());
    }
    draw(){
      if(!this.canvas||!this.stage)return;const rect=this.stage.getBoundingClientRect();if(!rect.width)return;const dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));const height=Math.max(92,Number(this.stage.dataset.waveHeight)||112);
      this.canvas.width=Math.round(rect.width*dpr);this.canvas.height=Math.round(height*dpr);this.canvas.style.width=`${rect.width}px`;this.canvas.style.height=`${height}px`;
      const ctx=this.canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const styles=getComputedStyle(this.stage);const accent=this.accent||styles.getPropertyValue('--wave-accent').trim()||'#38e5a5';const bg=styles.getPropertyValue('--wave-bg').trim()||'#07100c';const line=this.lineColor||styles.getPropertyValue('--wave-line').trim()||'#355346';
      ctx.clearRect(0,0,rect.width,height);ctx.fillStyle=bg;ctx.fillRect(0,0,rect.width,height);ctx.strokeStyle='rgba(255,255,255,.06)';for(let i=1;i<6;i++){const x=rect.width*i/6;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
      const view=this._viewWindow();const peaks=this.peaks||[];const mid=height/2;ctx.strokeStyle=line;ctx.globalAlpha=.9;ctx.beginPath();for(let x=0;x<rect.width;x++){const timeMs=view.start+(x/Math.max(1,rect.width))*view.size;const index=Math.max(0,Math.min(peaks.length-1,Math.floor((timeMs/this.durationMs)*peaks.length)));const amp=Number(peaks[index]||0)*(height*.39);ctx.moveTo(x,mid-amp);ctx.lineTo(x,mid+amp);}ctx.stroke();ctx.globalAlpha=1;
      const boundaries=[...this.markers.map((ms,i)=>({ms,type:'pause',index:i})),...(this.endMs!=null?[{ms:this.endMs,type:'end',index:-1}]:[])];
      let start=0;boundaries.forEach((item,idx)=>{const sx=((start-view.start)/view.size)*rect.width;const ex=((item.ms-view.start)/view.size)*rect.width;const a=Math.max(0,Math.min(rect.width,sx));const b=Math.max(0,Math.min(rect.width,ex));if(b>a){ctx.save();ctx.globalAlpha=idx%2===0?.07:.11;ctx.fillStyle=accent;ctx.fillRect(a,0,b-a,height);ctx.restore();}start=item.ms;});
      const drawMarker=(item)=>{const x=((item.ms-view.start)/view.size)*rect.width;if(x<0||x>rect.width)return;const color=item.type==='end'?this.endColor:accent;const selected=this.selectedType===item.type&&(item.type==='end'||this.selectedIndex===item.index);ctx.strokeStyle=color;ctx.lineWidth=selected?3:2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();const label=item.type==='end'?'END':'PAUSA';const width=item.type==='end'?40:48;const tabX=Math.max(1,Math.min(rect.width-width-1,x-width/2));ctx.save();ctx.fillStyle=selected?color:'#0d241a';ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();if(typeof ctx.roundRect==='function')ctx.roundRect(tabX,5,width,20,5);else ctx.rect(tabX,5,width,20);ctx.fill();ctx.stroke();ctx.fillStyle=selected?'#04110b':color;ctx.font='700 8px JetBrains Mono, monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,tabX+width/2,15);ctx.restore();};
      boundaries.forEach(drawMarker);
      const playMs=(Number(this.video?.currentTime)||0)*1000;if(playMs>=view.start&&playMs<=view.end){const px=((playMs-view.start)/view.size)*rect.width;ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,height);ctx.stroke();}
    }
  }


  window.MSGWaveEditor = { RangeEditor, MarkerEditor, isTyping, stepFromEvent, formatMs, parseMs, activateEditor };
})();
