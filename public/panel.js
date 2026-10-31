(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let store = null;
  let dragId = null;
  let editId = null;
  let es = null;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const pl = () => store?.playlists?.find((p) => p.id === (store.player?.playlistId || store.activeId)) || store?.playlists?.[0];
  const items = () => pl()?.items || [];
  const cur = () => items().find((i) => i.id === store?.player?.currentId) || null;

  async function api(path, opts) {
    const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  function setLink(n) {
    const el = $('#linkPill');
    if (n > 1) { el.textContent = `展厅已连接 · ${n} 端`; el.className = 'pill on'; }
    else if (n === 1) { el.textContent = '仅操作台在线'; el.className = 'pill warn'; }
    else { el.textContent = '未连接'; el.className = 'pill'; }
  }

  function renderTracks() {
    const list = items();
    const curId = store?.player?.currentId;
    $('#tracks').innerHTML = list.map((it, i) => {
      const badge = it.synth === 'ready' ? 'ready' : it.synth === 'error' ? 'error' : it.synth === 'running' ? 'running' : '';
      const label = it.synth === 'ready' ? '已合成' : it.synth === 'error' ? '失败' : it.synth === 'running' ? '合成中' : '未合成';
      return `<li draggable="true" data-id="${it.id}" class="${it.id === curId ? 'active' : ''} ${it.enabled === false ? 'disabled' : ''}">
        <span class="handle" title="拖拽排序">⠿</span>
        <span class="num">${i + 1}</span>
        <div class="meta"><div class="t">${esc(it.title)}</div><div class="d">${esc(it.text)}</div></div>
        <span class="badge ${badge}">${label}</span>
      </li>`;
    }).join('');
    $('#plName').textContent = pl()?.name || '话术播单';
  }

  function renderPlayer() {
    const it = cur();
    const p = store?.player || {};
    $('#nowTitle').textContent = it?.title || '—';
    $('#nowText').textContent = it?.text || '选择一条话术，或点播放。';
    $('#btnPlay').textContent = p.playing && !p.paused ? '⏸' : '▶';
    for (const b of $('#modes').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === p.mode);
    $('#gap').value = p.gapMs ?? 800; $('#gapVal').textContent = ((p.gapMs ?? 800) / 1000).toFixed(1) + 's';
    $('#vol').value = Math.round((p.volume ?? 1) * 100); $('#volVal').textContent = Math.round((p.volume ?? 1) * 100) + '%';
    $('#autostart').checked = !!p.autostart;
    renderTracks();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function refresh() {
    store = await api('/api/playlist');
    renderPlayer();
    setLink(store.clients || 0);
  }

  function connectSSE() {
    if (es) es.close();
    es = new EventSource('/api/playlist/events');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello' || msg.type === 'store') {
          store = msg.store; renderPlayer();
          if (msg.clients != null) setLink(msg.clients);
          else api('/api/playlist').then((s) => setLink(s.clients || 0)).catch(() => {});
        }
        if (msg.type === 'control') {
          if (msg.player) store.player = msg.player;
          renderPlayer();
        }
        if (msg.type === 'synth') {
          const st = msg.status || {};
          $('#synthBar').hidden = !st.running && !(st.done && st.total);
          if (st.total) {
            $('#synthFill').style.width = Math.round((st.done / st.total) * 100) + '%';
            $('#synthTxt').textContent = st.running
              ? `合成中 ${st.done}/${st.total}${st.current ? ' · ' + st.current.title : ''}`
              : `完成 ${st.done}/${st.total}${st.errors?.length ? '，失败 ' + st.errors.length : ''}`;
          }
          if (!st.running) refresh();
        }
      } catch {}
    };
    es.onerror = () => { $('#status').textContent = '事件通道重连中…'; };
  }

  async function control(action, extra = {}) {
    const j = await api('/api/playlist/control', { method: 'POST', body: JSON.stringify({ action, ...extra }) });
    if (j.player) store.player = j.player;
    renderPlayer();
    $('#status').textContent = ({ play: '已发送播放', pause: '已暂停', next: '下一首', prev: '上一首', stop: '已停止', toggle: '切换播放', ended: '切歌', mode: '已改模式', select: '已选中' })[action] || action;
  }

  // list interactions
  $('#tracks').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (e.target.closest('.handle')) return;
    control('play', { id: li.dataset.id });
  });
  $('#tracks').addEventListener('dblclick', (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    openEdit(li.dataset.id);
  });
  $('#tracks').addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    dragId = li.dataset.id; li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  $('#tracks').addEventListener('dragend', (e) => {
    const li = e.target.closest('li'); if (li) li.classList.remove('dragging');
    dragId = null;
  });
  $('#tracks').addEventListener('dragover', (e) => {
    e.preventDefault();
    const li = e.target.closest('li[data-id]'); if (!li || !dragId || li.dataset.id === dragId) return;
    const ids = items().map((i) => i.id);
    const from = ids.indexOf(dragId); const to = ids.indexOf(li.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // optimistic UI reorder
    const map = new Map(items().map((i) => [i.id, i]));
    pl().items = ids.map((id) => map.get(id));
    renderTracks();
  });
  $('#tracks').addEventListener('drop', async (e) => {
    e.preventDefault();
    const ids = [...$('#tracks').querySelectorAll('li[data-id]')].map((li) => li.dataset.id);
    store = await api('/api/playlist/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
    renderPlayer();
  });

  function openEdit(id) {
    editId = id || null;
    const it = id ? items().find((x) => x.id === id) : null;
    $('#editTitle').textContent = it ? '编辑话术' : '添加话术';
    $('#fTitle').value = it?.title || '';
    $('#fText').value = it?.text || '';
    const fv = $('#fVoice');
    fv.value = it?.voice || 'female';
    if (!fv.value) fv.value = 'female'; // 旧数据里的男声等已下线，回落晓晓
    $('#fEnabled').checked = it ? it.enabled !== false : true;
    $('#btnDelete').hidden = !it;
    $('#editDlg').showModal();
  }

  $('#btnAdd').onclick = () => openEdit(null);
  $('#btnCancel').onclick = () => $('#editDlg').close();
  $('#btnDelete').onclick = async () => {
    if (!editId || !confirm('删除这条话术？')) return;
    store = await api('/api/playlist/item', { method: 'DELETE', body: JSON.stringify({ id: editId }) });
    $('#editDlg').close(); renderPlayer();
  };
  $('#editForm').onsubmit = async (e) => {
    e.preventDefault();
    store = (await api('/api/playlist/item', {
      method: 'POST',
      body: JSON.stringify({
        id: editId, title: $('#fTitle').value.trim(), text: $('#fText').value.trim(),
        voice: $('#fVoice').value, enabled: $('#fEnabled').checked,
      }),
    })).store;
    $('#editDlg').close(); renderPlayer();
  };

  $('#btnImport').onclick = () => { $('#importText').value = ''; $('#importDlg').showModal(); };
  $('#importCancel').onclick = () => $('#importDlg').close();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    $('#importText').value = await f.text();
  };
  $('#importForm').onsubmit = async (e) => {
    e.preventDefault();
    const j = await api('/api/playlist/import', {
      method: 'POST',
      body: JSON.stringify({ text: $('#importText').value, replace: $('#importReplace').checked }),
    });
    store = j.store; $('#importDlg').close(); renderPlayer();
    $('#status').textContent = `已导入 ${j.imported} 条`;
  };

  $('#btnSynth').onclick = async () => {
    $('#synthBar').hidden = false; $('#synthTxt').textContent = '开始合成…'; $('#synthFill').style.width = '0%';
    try {
      await api('/api/playlist/synth', { method: 'POST', body: '{}' });
      $('#status').textContent = '正在后台合成，已合成的不会重复';
    } catch (err) {
      $('#status').textContent = '合成：' + err.message;
    }
  };
  $('#btnRefresh').onclick = () => refresh();

  $('#btnPlay').onclick = () => control('toggle');
  $('#btnPrev').onclick = () => control('prev');
  $('#btnNext').onclick = () => control('next');
  $('#modes').onclick = (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    control('mode', { mode: b.dataset.mode });
  };
  $('#gap').oninput = () => { $('#gapVal').textContent = (Number($('#gap').value) / 1000).toFixed(1) + 's'; };
  $('#gap').onchange = () => control('mode', { gapMs: Number($('#gap').value) });
  $('#vol').oninput = () => { $('#volVal').textContent = $('#vol').value + '%'; };
  $('#vol').onchange = () => control('mode', { volume: Number($('#vol').value) / 100 });
  $('#autostart').onchange = () => control('mode', { autostart: $('#autostart').checked });

  // local seek preview only — actual seek goes to kiosk
  let seekTimer = null;
  $('#seek').addEventListener('input', () => {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const ratio = Number($('#seek').value) / 1000;
      // duration unknown here; send as fraction via seconds=-1 hack? send ratio*estimated
      control('seek', { seconds: ratio }); // kiosk interprets 0~1 as ratio if < 2? Better: send ratio field
    }, 120);
  });
  // Override seek to send ratio
  $('#seek').oninput = () => {
    clearTimeout(seekTimer);
    const ratio = Number($('#seek').value) / 1000;
    $('#tCur').textContent = Math.round(ratio * 100) + '%';
    seekTimer = setTimeout(() => {
      api('/api/playlist/control', { method: 'POST', body: JSON.stringify({ action: 'seek', ratio }) }).catch(() => {});
    }, 100);
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.code === 'Space') { e.preventDefault(); control('toggle'); }
    if (e.code === 'ArrowRight') control('next');
    if (e.code === 'ArrowLeft') control('prev');
  });

  refresh().then(connectSSE);
})();
