'use strict';

const $ = id => document.getElementById(id);
const cards = window.CARD_DATA || [];
const presets = window.DECK_DATA || {};
const cardsById = new Map(cards.map(card => [String(card.id), card]));
const quantities = new Map();
const STORAGE_KEY = 'mcdd-saved-decks-v1';
const DRAFT_KEY = 'mcdd-current-deck-v1';
const PUBLICATIONS_KEY = 'mcdd-shared-decks-v1';
const VISIT_SESSION_KEY = 'mcdd-visit-counted-v1';
const cloudConfig = window.MCDD_SUPABASE_CONFIG || {};
const cloudEnabled = Boolean(cloudConfig.url && cloudConfig.publishableKey && window.supabase?.createClient);
const cloud = cloudEnabled ? window.supabase.createClient(cloudConfig.url, cloudConfig.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
}) : null;

let activeDeckId = null;
let dirty = false;
let incomingDeck = null;
let authUser = null;
let cloudDecks = [];
let communityDecks = [];
let cloudBusy = false;
let saveBusy = false;
let shareBusy = false;
let communityState = 'idle';
let communityError = '';
let communityPage = 0;
let communityHasMore = false;
let communityRequestId = 0;
let communityLoading = false;
let draftTimer = null;
const COMMUNITY_PAGE_SIZE = 20;
const communityCache = new Map();

const ENVIRONMENTS = {
  bp01: { label: '第一弹环境', sets: new Set(['SD01', 'SD02', 'BP01']) },
  bp02: { label: '第二弹环境', sets: new Set(['SD01', 'SD02', 'BP01', 'BP02']) }
};

function environmentLabel(value) {
  return ENVIRONMENTS[value]?.label || ENVIRONMENTS.bp01.label;
}

function cardSet(card) {
  const set = String(card.code?.split('-')[0] || card.obtain || '').toUpperCase();
  if (/^SD\d+/.test(set)) return 'starter';
  return set.toLowerCase();
}

function cardSetLabel(card) {
  const set = cardSet(card);
  if (set === 'starter') return '起始卡组';
  if (set === 'bp01') return '第一弹';
  if (set === 'bp02') return '第二弹';
  return String(card.obtain || set || '未分类');
}

function cardAllowedInEnvironment(card, environment = $('deckEnvironment')?.value || 'bp01') {
  const set = String(card.code?.split('-')[0] || card.obtain || '').toUpperCase();
  return ENVIRONMENTS[environment]?.sets.has(set) ?? true;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function setStatus(message, tone = '') {
  $('status').textContent = message;
  $('status').className = tone;
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.random() * 16 | 0;
    return (char === 'x' ? value : value & 3 | 8).toString(16);
  });
}

function readStorage(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function cleanQuantities(raw) {
  const result = {};
  const entries = Array.isArray(raw) ? raw : Object.entries(raw || {});
  for (const entry of entries) {
    const [rawId, rawQuantity] = Array.isArray(entry) ? entry : [];
    const id = String(rawId);
    const quantity = Number(rawQuantity);
    if (cardsById.has(id) && Number.isInteger(quantity) && quantity > 0 && quantity <= 99) {
      result[id] = quantity;
    }
  }
  return result;
}

function normalizeDeck(raw, fallbackId = null) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId || makeId(),
    name: String(raw.name || '未命名卡组').slice(0, 40),
    description: String(raw.description || '').slice(0, 300),
    environment: ENVIRONMENTS[raw.environment] ? raw.environment : 'bp01',
    cards: cleanQuantities(raw.cards),
    isPublic: Boolean(raw.isPublic ?? raw.is_public),
    authorName: String(raw.authorName || raw.author_name || '玩家').slice(0, 40),
    ownerId: raw.ownerId || raw.owner_id || null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

function currentSnapshot(overrides = {}) {
  return normalizeDeck({
    id: activeDeckId || makeId(),
    name: $('deckName').value.trim() || '未命名卡组',
    description: $('deckDescription').value.trim(),
    environment: $('deckEnvironment').value,
    cards: Object.fromEntries([...quantities].filter(([, quantity]) => quantity > 0)),
    createdAt: overrides.createdAt,
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

function persistDraftNow() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(currentSnapshot({ id: activeDeckId || 'draft' })));
  } catch {
    setStatus('浏览器无法保存当前草稿，请检查隐私或存储设置。', 'error');
  }
}

function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(persistDraftNow, 400);
}

function restoreDraft() {
  try {
    const draft = normalizeDeck(JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'), 'draft');
    if (!draft) return;
    $('deckName').value = draft.name;
    $('deckDescription').value = draft.description;
    $('deckEnvironment').value = draft.environment;
    quantities.clear();
    Object.entries(draft.cards).forEach(([id, quantity]) => quantities.set(id, quantity));
    activeDeckId = draft.id === 'draft' ? null : draft.id;
  } catch {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function markDirty() {
  dirty = true;
  persistDraft();
}

function ordered() {
  return cards.slice().sort((a, b) => {
    const mode = $('sort').value;
    const promoOrder = Number(Boolean(a.promo)) - Number(Boolean(b.promo));
    const primary = mode === 'starsAsc'
      ? a.stars - b.stars || promoOrder
      : mode === 'starsDesc'
        ? b.stars - a.stars || promoOrder
        : 0;
    return primary || a.code.localeCompare(b.code) || a.rarity.localeCompare(b.rarity) || Number(a.id) - Number(b.id);
  });
}

function filtered() {
  const query = $('search').value.trim().toLowerCase();
  const type = $('type').value;
  const rarity = $('rarity').value;
  const set = $('cardSet').value;
  return ordered().filter(card =>
    cardAllowedInEnvironment(card) &&
    (!type || card.type === type) &&
    (!set || cardSet(card) === set) &&
    (!rarity || card.rarity === rarity) &&
    (!$('selected').checked || quantities.get(String(card.id))) &&
    [card.code, card.name, card.text].join(' ').toLowerCase().includes(query)
  );
}

function selectedCards(source = quantities) {
  return ordered().flatMap(card => Array.from({ length: source.get(String(card.id)) || 0 }, () => card));
}

function aggregateCodes(source = quantities) {
  const result = new Map();
  for (const [id, quantity] of source) {
    if (!quantity) continue;
    const card = cardsById.get(String(id));
    if (!card) continue;
    const current = result.get(card.code) || { card, quantity: 0 };
    current.quantity += quantity;
    result.set(card.code, current);
  }
  return result;
}

function exclusiveCharacters(card) {
  if (Array.isArray(card.exclusiveCharacters)) return card.exclusiveCharacters.filter(Boolean);
  if (typeof card.exclusiveCharacter === 'string' && card.exclusiveCharacter.trim()) return [card.exclusiveCharacter.trim()];
  return [];
}

function hasExclusiveField(card) {
  return Object.prototype.hasOwnProperty.call(card, 'exclusiveCharacter') ||
    Object.prototype.hasOwnProperty.call(card, 'exclusiveCharacters');
}

function analyzeDeck(source = quantities, environment = $('deckEnvironment').value) {
  const codeTotals = aggregateCodes(source);
  const roleCards = [];
  const actionCards = [];
  for (const [id, quantity] of source) {
    if (!quantity) continue;
    const card = cardsById.get(String(id));
    if (!card) continue;
    (card.type === 'role' ? roleCards : actionCards).push({ card, quantity });
  }

  const roleTotal = roleCards.reduce((sum, item) => sum + item.quantity, 0);
  const actionTotal = actionCards.reduce((sum, item) => sum + item.quantity, 0);
  const characterNames = [...new Set(roleCards.map(item => item.card.name))];
  const errors = [];
  const warnings = [];

  const disallowed = [...source].filter(([id, quantity]) => quantity && !cardAllowedInEnvironment(cardsById.get(String(id)), environment));
  if (disallowed.length) errors.push(`有 ${disallowed.length} 个卡图版本不属于${environmentLabel(environment)}。`);

  if (roleTotal < 3 || roleTotal > 15) errors.push(`角色卡组需要 3–15 张，目前 ${roleTotal} 张。`);
  if (characterNames.length !== 3) errors.push(`角色卡组需要恰好 3 种角色，目前 ${characterNames.length} 种。`);

  for (const name of characterNames) {
    const levelZeroCount = roleCards
      .filter(item => item.card.name === name && Number(item.card.level) === 0)
      .reduce((sum, item) => sum + item.quantity, 0);
    if (levelZeroCount !== 1) errors.push(`角色“${name}”需要恰好 1 张 0 级卡，目前 ${levelZeroCount} 张。`);
  }

  for (const { card, quantity } of codeTotals.values()) {
    const maximum = card.type === 'role' ? 1 : 3;
    if (quantity > maximum) errors.push(`${card.code} 的不同版本合计 ${quantity} 张，最多 ${maximum} 张。`);
  }

  if (actionTotal !== 40) errors.push(`行动卡组需要正好 40 张，目前 ${actionTotal} 张。`);

  const roleNameSet = new Set(characterNames);
  let unknownExclusiveCards = 0;
  for (const { card } of actionCards) {
    if (!hasExclusiveField(card)) {
      unknownExclusiveCards += 1;
      continue;
    }
    const exclusive = exclusiveCharacters(card);
    if (exclusive.length && !exclusive.some(name => roleNameSet.has(name))) {
      errors.push(`${card.code}“${card.name}”的专属角色不在角色卡组中。`);
    }
  }
  if (unknownExclusiveCards) warnings.push('专属角色字段尚未补全，专属行动卡限制暂未参与自动校验。');

  return { roleTotal, actionTotal, characterNames, codeTotals, errors, warnings };
}

function config() {
  const width = Number($('width').value);
  const height = Number($('height').value);
  const gap = Number($('gap').value);
  if (!Number.isFinite(width + height + gap) || width < 20 || width > 190 || height < 20 || height > 277 || gap < 2 || gap > 10) {
    throw Error('请设置有效尺寸：宽 20–190、高 20–277、间距 2–10 毫米。');
  }
  const columns = Math.floor((198 + gap) / (width + gap));
  const rows = Math.floor((285 + gap) / (height + gap));
  if (!columns || !rows) throw Error('当前卡片尺寸和间距无法排入 A4 页面。');
  return { width, height, gap, columns, rows, capacity: columns * rows };
}

function setQuantity(id, quantity) {
  const normalizedId = String(id);
  if (!cardsById.has(normalizedId) || !Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    throw Error('每个卡图版本的份数必须是 0–99 的整数。');
  }
  if (quantity) quantities.set(normalizedId, quantity);
  else quantities.delete(normalizedId);
  markDirty();
}

function renderGallery() {
  const visible = filtered();
  const codeTotals = aggregateCodes();
  $('libraryCount').textContent = `${cards.length} 个版本 · ${new Set(cards.map(card => card.code)).size} 个卡号`;
  $('filteredCount').textContent = `匹配 ${visible.length} 个版本`;
  $('sourceCount').textContent = `${cards.length} 个版本 / ${new Set(cards.map(card => card.code)).size} 个不同卡号`;
  const renderCards = group => group.map(card => {
    const quantity = quantities.get(String(card.id)) || 0;
    const logicalQuantity = codeTotals.get(card.code)?.quantity || 0;
    const limit = card.type === 'role' ? 1 : 3;
    return `<article class="card ${quantity ? 'chosen' : ''}" data-id="${escapeHtml(card.id)}">
      <button class="image-button" data-show="${escapeHtml(card.id)}" aria-label="查看 ${escapeHtml(card.name)} 大图"><img src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)} ${escapeHtml(card.id)}" loading="lazy"></button>
      <div class="card-title"><h3 title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</h3><span>${escapeHtml(card.rarity)}</span></div>
      <div class="card-meta"><span>${escapeHtml(card.code)}</span><span>${escapeHtml(cardSetLabel(card))} · ${card.type === 'role' ? `角色 ${escapeHtml(card.level)}级` : '行动'}</span></div>
      <div class="code-limit ${logicalQuantity > limit ? 'over' : ''}">同编号合计 ${logicalQuantity} / ${limit}</div>
      <div class="counter"><button data-delta="-1" aria-label="减少 ${escapeHtml(card.id)} 份数">−</button><input type="number" min="0" max="99" value="${quantity}" aria-label="${escapeHtml(card.code)} ${escapeHtml(card.rarity)} 份数"><button data-delta="1" aria-label="增加 ${escapeHtml(card.id)} 份数">＋</button></div>
    </article>`;
  }).join('');
  const roles = visible.filter(card => card.type === 'role');
  const actions = visible.filter(card => card.type === 'action');
  $('gallery').innerHTML = visible.length ? `${roles.length ? `<section class="card-section"><h2>角色卡组 <small>${roles.length} 个版本</small></h2><div class="card-grid">${renderCards(roles)}</div></section>` : ''}${actions.length ? `<section class="card-section"><h2>行动卡组 <small>${actions.length} 个版本</small></h2><div class="card-grid">${renderCards(actions)}</div></section>` : ''}` : '<p class="empty">没有匹配的卡牌。</p>';
}

function renderQuantityChange(id) {
  if ($('selected').checked) {
    renderGallery();
  } else {
    const card = cardsById.get(String(id));
    const quantity = quantities.get(String(id)) || 0;
    const article = $('gallery').querySelector(`article[data-id="${CSS.escape(String(id))}"]`);
    if (article) {
      article.classList.toggle('chosen', Boolean(quantity));
      const input = article.querySelector('input');
      if (input) input.value = quantity;
    }
    if (card) {
      const logicalQuantity = aggregateCodes().get(card.code)?.quantity || 0;
      const limit = card.type === 'role' ? 1 : 3;
      for (const version of cards.filter(item => item.code === card.code)) {
        const row = $('gallery').querySelector(`article[data-id="${CSS.escape(String(version.id))}"] .code-limit`);
        if (row) {
          row.textContent = `同编号合计 ${logicalQuantity} / ${limit}`;
          row.classList.toggle('over', logicalQuantity > limit);
        }
      }
    }
  }
  renderValidation();
  updatePrintStats();
  $('headerDeckName').textContent = `${$('deckName').value.trim() || '未命名卡组'} · 未保存`;
}

function renderValidation() {
  const analysis = analyzeDeck();
  $('roleTotal').textContent = analysis.roleTotal;
  $('actionTotal').textContent = analysis.actionTotal;
  $('characterKinds').textContent = `${analysis.characterNames.length} / 3`;
  const state = $('validationState');
  if (analysis.errors.length) {
    state.className = 'validation-state invalid';
    state.textContent = `草稿 · ${analysis.errors.length} 项需要调整`;
  } else if (analysis.warnings.length) {
    state.className = 'validation-state warning';
    state.textContent = '基础规则通过 · 仍有字段待校验';
  } else {
    state.className = 'validation-state valid';
    state.textContent = '卡组符合当前全部构筑规则';
  }
  const messages = [
    ...analysis.errors.map(text => ({ text, type: 'error' })),
    ...analysis.warnings.map(text => ({ text, type: 'warning' }))
  ];
  $('validationList').innerHTML = messages.slice(0, 8).map(item => `<li class="${item.type}">${escapeHtml(item.text)}</li>`).join('');
  if (messages.length > 8) $('validationList').insertAdjacentHTML('beforeend', `<li>另有 ${messages.length - 8} 项提示。</li>`);
  return analysis;
}

function updatePrintStats() {
  const count = selectedCards().length;
  $('total').textContent = count;
  $('print').disabled = !count;
  $('preview').disabled = !count;
  try {
    const page = config();
    $('pages').textContent = Math.ceil(count / page.capacity);
    $('layoutNote').textContent = `A4 纵向 · 每页 ${page.columns} 列 × ${page.rows} 行 · 单面打印`;
  } catch (error) {
    $('pages').textContent = '—';
    $('layoutNote').textContent = error.message;
  }
}

function renderPrintSummary() {
  const selected = ordered().filter(card => quantities.get(String(card.id)));
  if (!selected.length) {
    $('printDeckSummary').innerHTML = '<p class="empty-panel">当前卡组还没有卡牌，请先返回编辑卡组。</p>';
    return;
  }
  const renderGroup = (title, type) => {
    const group = selected.filter(card => card.type === type);
    const total = group.reduce((sum, card) => sum + quantities.get(String(card.id)), 0);
    return `<section class="print-group"><h2>${title}<small>${total} 张</small></h2><div class="print-card-list">${group.map(card => `<article><img src="${escapeHtml(card.image)}" alt=""><div><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.code)} · ${escapeHtml(card.rarity)}</span></div><b>× ${quantities.get(String(card.id))}</b></article>`).join('')}</div></section>`;
  };
  $('printDeckSummary').innerHTML = renderGroup('角色卡组', 'role') + renderGroup('行动卡组', 'action');
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function deckCounts(deck) {
  const source = new Map(Object.entries(cleanQuantities(deck.cards)));
  const analysis = analyzeDeck(source, deck.environment);
  return `${analysis.roleTotal} 张角色卡 · ${analysis.actionTotal} 张行动卡`;
}

function cloudRowToDeck(row) {
  return normalizeDeck({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    environment: row.environment,
    cards: row.cards,
    isPublic: row.is_public,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function cloudDeckRow(deck, isPublic = deck.isPublic) {
  return {
    id: deck.id,
    owner_id: authUser.id,
    name: deck.name,
    description: deck.description,
    environment: deck.environment,
    cards: deck.cards,
    is_public: Boolean(isPublic),
    author_name: String(authUser.user_metadata?.display_name || '玩家').slice(0, 40),
    created_at: deck.createdAt,
    updated_at: new Date().toISOString()
  };
}

function updateAccountUi() {
  $('accountSummary').hidden = !authUser;
  $('accountEmail').textContent = authUser?.email || '';
  $('accountButton').hidden = Boolean(authUser);
  $('signOutButton').hidden = !authUser;
  $('importLocalDecks').hidden = !authUser || !readStorage(STORAGE_KEY).length;
  $('savedAccountTitle').textContent = authUser ? '云端卡组已启用' : cloudEnabled ? '尚未登录' : '云端尚未配置';
  $('savedDecksNote').textContent = authUser
    ? `已登录 ${authUser.email}，保存操作会同步到账号。当前草稿仍会保留在本机。`
    : cloudEnabled
      ? '当前使用本机保存。登录后可以跨设备同步自己的卡组。'
      : '当前使用本机保存。完成 config.js 和数据库配置后即可启用账号同步。';
  $('communityNote').textContent = authUser
    ? '点击“分享当前卡组”会把卡组发布到公共广场，并生成可直接打开的链接。'
    : cloudEnabled
      ? '可以浏览公共卡组；登录后可以保存和发布自己的卡组。未登录时仍可生成自包含分享链接。'
      : '云端尚未配置，目前继续使用自包含分享链接和本机分享记录。';
}

async function loadMyCloudDecks() {
  if (!cloud || !authUser) {
    cloudDecks = [];
    renderSavedDecks();
    return;
  }
  const { data, error } = await cloud.from('decks').select('*').eq('owner_id', authUser.id).order('updated_at', { ascending: false });
  if (error) throw error;
  cloudDecks = (data || []).map(cloudRowToDeck).filter(Boolean);
  renderSavedDecks();
}

async function loadCommunityDecks({ reset = true } = {}) {
  if (communityLoading) return;
  communityLoading = true;
  $('loadMoreCommunity').disabled = true;
  if (!cloud) {
    communityDecks = [];
    communityState = 'ready';
    renderPublishedDecks();
    communityLoading = false;
    $('loadMoreCommunity').disabled = false;
    return;
  }
  const environment = $('communityEnvironment').value;
  const cacheKey = environment || 'all';
  if (reset && communityCache.has(cacheKey)) {
    communityDecks = communityCache.get(cacheKey);
    communityState = 'ready';
    renderPublishedDecks();
  } else if (reset) {
    communityState = 'loading';
    communityError = '';
    renderPublishedDecks();
  }
  const requestId = ++communityRequestId;
  const page = reset ? 0 : communityPage + 1;
  let query = cloud.from('decks').select('*').eq('is_public', true).order('updated_at', { ascending: false });
  if (environment) query = query.eq('environment', environment);
  const from = page * COMMUNITY_PAGE_SIZE;
  const { data, error } = await query.range(from, from + COMMUNITY_PAGE_SIZE);
  if (requestId !== communityRequestId) {
    communityLoading = false;
    $('loadMoreCommunity').disabled = false;
    return;
  }
  if (error) {
    communityState = 'error';
    communityError = error.message;
    renderPublishedDecks();
    communityLoading = false;
    $('loadMoreCommunity').disabled = false;
    return;
  }
  const rows = (data || []).map(cloudRowToDeck).filter(Boolean);
  communityPage = page;
  communityHasMore = rows.length > COMMUNITY_PAGE_SIZE;
  const visibleRows = rows.slice(0, COMMUNITY_PAGE_SIZE);
  communityDecks = reset ? visibleRows : [...communityDecks, ...visibleRows];
  communityCache.set(cacheKey, communityDecks);
  communityState = 'ready';
  communityError = '';
  renderPublishedDecks();
  communityLoading = false;
  $('loadMoreCommunity').disabled = false;
}

function deckCoverCards(deck) {
  const seenCodes = new Set();
  return Object.entries(cleanQuantities(deck.cards)).flatMap(([id, quantity]) => {
    const card = cardsById.get(String(id));
    if (!quantity || !card || card.type !== 'role' || String(card.level) !== '0' || seenCodes.has(card.code)) return [];
    seenCodes.add(card.code);
    return [card];
  }).slice(0, 3);
}

function deckCoverHtml(deck) {
  const covers = deckCoverCards(deck);
  return `<div class="deck-covers" aria-label="0级角色卡预览">${covers.length
    ? covers.map(card => `<img class="deck-cover" src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)} 0级角色卡" loading="lazy">`).join('')
    : '<span class="deck-cover-placeholder">暂无<br>0级角色</span>'}</div>`;
}

async function loadSiteStats(incrementVisit = false) {
  if (!cloud) return false;
  const { data, error } = await cloud.rpc('get_site_stats', { increment_visit: incrementVisit });
  if (error) return false;
  const stats = Array.isArray(data) ? data[0] : data;
  if (!stats) return false;
  $('visitCount').textContent = Number(stats.total_visits || 0).toLocaleString('zh-CN');
  $('registrationCount').textContent = Number(stats.total_registrations || 0).toLocaleString('zh-CN');
  return true;
}

async function initializeSiteStats() {
  let incrementVisit = true;
  try { incrementVisit = sessionStorage.getItem(VISIT_SESSION_KEY) !== '1'; } catch {}
  if (await loadSiteStats(incrementVisit) && incrementVisit) {
    try { sessionStorage.setItem(VISIT_SESSION_KEY, '1'); } catch {}
  }
}

async function refreshCloudDecks() {
  if (!cloud || cloudBusy) return;
  cloudBusy = true;
  try {
    await Promise.all([loadMyCloudDecks(), loadCommunityDecks({ reset: true })]);
  } catch (error) {
    setStatus(`云端数据读取失败：${error.message}`, 'error');
  } finally {
    cloudBusy = false;
  }
}

function renderSavedDecks() {
  const saved = authUser ? cloudDecks : readStorage(STORAGE_KEY).map(item => normalizeDeck(item)).filter(Boolean);
  const source = authUser ? 'cloud' : 'local';
  $('savedDecks').innerHTML = saved.length ? saved.map(deck => `<article class="deck-row">
    ${deckCoverHtml(deck)}<div><h2>${escapeHtml(deck.name)}</h2><p>${escapeHtml(deck.description || '暂无说明')}</p><span class="${source}-badge">${source === 'cloud' ? '云端' : '本机'}</span><span class="public-badge">${escapeHtml(environmentLabel(deck.environment))}</span>${deck.isPublic ? '<span class="public-badge">已公开</span>' : ''}<span>${escapeHtml(deckCounts(deck))} · 更新于 ${escapeHtml(formatDate(deck.updatedAt))}</span></div>
    <div class="row-actions"><button data-load-deck="${escapeHtml(deck.id)}" data-source="${source}">查看 / 编辑</button><button data-copy-deck="${escapeHtml(deck.id)}" data-source="${source}">复制</button><button data-share-deck="${escapeHtml(deck.id)}" data-source="${source}">${source === 'cloud' ? '发布' : '分享'}</button><button class="danger" data-delete-deck="${escapeHtml(deck.id)}" data-source="${source}">删除</button></div>
  </article>`).join('') : `<p class="empty-panel">${authUser ? '账号中还没有卡组。编辑一副卡组后点击“保存卡组”。' : '还没有保存的卡组。编辑一副卡组后点击“保存卡组”。'}</p>`;
}

function renderPublishedDecks() {
  if (cloud) {
    $('publishedDecksHeading').textContent = '公开卡组广场';
    $('loadMoreCommunity').hidden = true;
    if (communityState === 'loading' || communityState === 'idle') {
      $('publishedDecks').innerHTML = '<div class="loading-panel" aria-label="正在加载公开卡组"><div class="loading-bar"></div><div class="loading-bar"></div><div class="loading-bar"></div></div>';
      return;
    }
    if (communityState === 'error') {
      $('publishedDecks').innerHTML = `<p class="empty-panel">公开卡组加载失败：${escapeHtml(communityError)}<br>请点击上方“刷新”重试。</p>`;
      return;
    }
    $('publishedDecks').innerHTML = communityDecks.length ? communityDecks.map(deck => `<article class="deck-row">
      ${deckCoverHtml(deck)}<div><h2>${escapeHtml(deck.name)}</h2><p>${escapeHtml(deck.description || '暂无说明')}</p><span class="public-badge">${escapeHtml(environmentLabel(deck.environment))}</span><span class="public-badge">${escapeHtml(deck.authorName)}</span><span>${escapeHtml(deckCounts(deck))} · 更新于 ${escapeHtml(formatDate(deck.updatedAt))}</span></div>
      <div class="row-actions"><button data-load-community="${escapeHtml(deck.id)}" class="primary">查看并复制</button><button data-link-community="${escapeHtml(deck.id)}">复制链接</button></div>
    </article>`).join('') : `<p class="empty-panel">${$('communityEnvironment').value ? environmentLabel($('communityEnvironment').value) : '当前筛选条件'}还没有公开卡组。</p>`;
    $('loadMoreCommunity').hidden = !communityHasMore;
    return;
  }
  const published = readStorage(PUBLICATIONS_KEY).map(item => normalizeDeck(item)).filter(Boolean);
  $('publishedDecksHeading').textContent = '本机分享记录';
  $('publishedDecks').innerHTML = published.length ? published.map(deck => `<article class="deck-row">
    ${deckCoverHtml(deck)}<div><h2>${escapeHtml(deck.name)}</h2><p>${escapeHtml(deck.description || '暂无说明')}</p><span class="public-badge">${escapeHtml(environmentLabel(deck.environment))}</span><span>${escapeHtml(deckCounts(deck))} · 分享于 ${escapeHtml(formatDate(deck.publishedAt || deck.updatedAt))}</span></div>
    <div class="row-actions"><button data-load-published="${escapeHtml(deck.id)}">查看并复制</button><button data-link-published="${escapeHtml(deck.id)}">复制链接</button><button class="danger" data-delete-published="${escapeHtml(deck.id)}">删除记录</button></div>
  </article>`).join('') : '<p class="empty-panel">还没有分享记录。点击“分享当前卡组”生成公开链接。</p>';
}

function renderIncomingDeck() {
  if (!incomingDeck) {
    $('incomingDeck').innerHTML = '<div class="shared-placeholder"><strong>通过分享链接查看别人的卡组</strong><span>打开含有卡组数据的链接后，卡组详情会显示在这里。</span></div>';
    return;
  }
  const analysis = analyzeDeck(new Map(Object.entries(incomingDeck.cards)), incomingDeck.environment);
  const state = analysis.errors.length ? `草稿，${analysis.errors.length} 项基础规则未通过` : '基础规则通过';
  $('incomingDeck').innerHTML = `<article class="shared-deck"><p class="eyebrow">收到的卡组</p><div class="shared-deck-layout">${deckCoverHtml(incomingDeck)}<div><h2>${escapeHtml(incomingDeck.name)}</h2><p>${escapeHtml(incomingDeck.description || '暂无说明')}</p><div class="shared-meta"><span>${escapeHtml(environmentLabel(incomingDeck.environment))}</span><span>${analysis.roleTotal} 张角色卡</span><span>${analysis.actionTotal} 张行动卡</span><span>${escapeHtml(state)}</span></div><div class="row-actions"><button id="copyIncoming" class="primary">复制到我的编辑器</button><button id="printIncoming">载入并打印</button></div></div></div></article>`;
}

function renderAll() {
  renderGallery();
  renderValidation();
  updatePrintStats();
  updateAccountUi();
  $('headerDeckName').textContent = `${$('deckName').value.trim() || '未命名卡组'}${dirty ? ' · 未保存' : ''}`;
}

function setView(view) {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  }
  for (const section of document.querySelectorAll('.view')) {
    const active = section.id === `${view}View`;
    section.hidden = !active;
    section.classList.toggle('active', active);
  }
  const printing = view === 'print';
  $('deckAside').hidden = printing;
  $('printAside').hidden = !printing;
  document.body.dataset.view = view;
  if (printing) renderPrintSummary();
  if (view === 'saved') {
    renderSavedDecks();
    if (authUser) void refreshCloudDecks();
  }
  if (view === 'community') {
    renderIncomingDeck();
    renderPublishedDecks();
    if (cloud) void refreshCloudDecks();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadDeck(deck, copy = false, destination = 'editor') {
  const normalized = normalizeDeck(deck);
  if (!normalized) return;
  quantities.clear();
  Object.entries(normalized.cards).forEach(([id, quantity]) => quantities.set(id, quantity));
  $('search').value = '';
  $('type').value = '';
  $('rarity').value = '';
  $('cardSet').value = '';
  $('selected').checked = true;
  $('deckName').value = copy ? `${normalized.name}（副本）`.slice(0, 40) : normalized.name;
  $('deckDescription').value = normalized.description;
  $('deckEnvironment').value = normalized.environment;
  activeDeckId = copy ? null : normalized.id;
  dirty = copy;
  persistDraftNow();
  renderAll();
  setView(destination);
  $('deckNote').textContent = '当前只显示这副卡组实际使用的卡；取消“只看已选”即可继续添加其他卡。';
  setStatus(copy ? '已复制到编辑器，并只显示卡组中已有的卡。' : `已载入“${normalized.name}”，当前只显示卡组中已有的卡。`, 'success');
}

function confirmAction({ title, eyebrow = 'CONFIRM', content, acceptText = '确认' }) {
  return new Promise(resolve => {
    const dialog = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmEyebrow').textContent = eyebrow;
    $('confirmContent').innerHTML = content;
    $('confirmAccept').textContent = acceptText;
    let accepted = false;
    const accept = () => { accepted = true; dialog.close(); };
    const cancel = () => dialog.close();
    const closed = () => {
      $('confirmAccept').removeEventListener('click', accept);
      $('confirmCancel').removeEventListener('click', cancel);
      resolve(accepted);
    };
    $('confirmAccept').addEventListener('click', accept);
    $('confirmCancel').addEventListener('click', cancel);
    dialog.addEventListener('close', closed, { once: true });
    dialog.showModal();
  });
}

function deckConfirmationContent(deck) {
  const analysis = analyzeDeck(new Map(Object.entries(deck.cards)), deck.environment);
  const state = analysis.errors.length ? `${analysis.errors.length} 项基础规则未通过` : '基础规则通过';
  return `<p><strong>${escapeHtml(deck.name)}</strong></p><ul><li>${escapeHtml(environmentLabel(deck.environment))}</li><li>${analysis.roleTotal} 张角色卡，${analysis.actionTotal} 张行动卡</li><li>${escapeHtml(state)}</li></ul>`;
}

async function saveCurrentDeck() {
  if (saveBusy) return;
  const draft = currentSnapshot();
  if (!await confirmAction({ title: '保存这副卡组？', eyebrow: 'SAVE DECK', content: deckConfirmationContent(draft), acceptText: '确认保存' })) return;
  saveBusy = true;
  ['saveCurrent', 'saveCurrentTop'].forEach(id => { $(id).disabled = true; });
  try {
    let snapshot;
    if (cloud && authUser) {
      const existing = cloudDecks.find(item => item.id === activeDeckId);
      snapshot = currentSnapshot({ id: existing?.id || makeId(), createdAt: existing?.createdAt || new Date().toISOString(), isPublic: existing?.isPublic });
      const { data, error } = await cloud.from('decks').upsert(cloudDeckRow(snapshot), { onConflict: 'id' }).select().single();
      if (error) throw error;
      snapshot = cloudRowToDeck(data);
      cloudDecks = [snapshot, ...cloudDecks.filter(item => item.id !== snapshot.id)];
    } else {
      const saved = readStorage(STORAGE_KEY).map(item => normalizeDeck(item)).filter(Boolean);
      const existing = saved.find(item => item.id === activeDeckId);
      snapshot = currentSnapshot({ id: activeDeckId || makeId(), createdAt: existing?.createdAt || new Date().toISOString() });
      const index = saved.findIndex(item => item.id === snapshot.id);
      if (index >= 0) saved[index] = snapshot;
      else saved.unshift(snapshot);
      writeStorage(STORAGE_KEY, saved);
    }
    activeDeckId = snapshot.id;
    dirty = false;
    persistDraftNow();
    renderAll();
    renderSavedDecks();
    setStatus(`已保存“${snapshot.name}”到${authUser ? '你的账号' : '这台设备'}。`, 'success');
    setView('saved');
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error');
  } finally {
    saveBusy = false;
    ['saveCurrent', 'saveCurrentTop'].forEach(id => { $(id).disabled = false; });
  }
}

function encodeDeck(deck) {
  const payload = JSON.stringify({ v: 2, name: deck.name, description: deck.description, environment: deck.environment, cards: Object.entries(deck.cards) });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeDeck(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (![1, 2].includes(parsed.v)) return null;
    return normalizeDeck({ name: parsed.name, description: parsed.description, environment: parsed.environment || 'bp01', cards: parsed.cards });
  } catch {
    return null;
  }
}

function shareUrl(deck) {
  return `${location.href.split('#')[0]}#deck=${encodeDeck(deck)}`;
}

function cloudDeckUrl(id) {
  return `${location.href.split('#')[0]}#cloud=${encodeURIComponent(id)}`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

async function publishDeck(deck = currentSnapshot()) {
  if (shareBusy) return;
  let snapshot = normalizeDeck(deck);
  if (!await confirmAction({ title: '公开分享这副卡组？', eyebrow: 'SHARE DECK', content: `${deckConfirmationContent(snapshot)}<p>确认后，卡组名称、说明、环境、作者昵称和卡牌清单会公开显示。</p>`, acceptText: '确认分享' })) return;
  shareBusy = true;
  $('shareCurrent').disabled = true;
  document.querySelectorAll('[data-share-deck]').forEach(button => { button.disabled = true; });
  let url;
  try {
    if (cloud && authUser) {
    try {
      const owned = cloudDecks.find(item => item.id === snapshot.id);
      snapshot = normalizeDeck({ ...snapshot, id: owned?.id || makeId(), createdAt: owned?.createdAt || snapshot.createdAt, isPublic: true });
      const { data, error } = await cloud.from('decks').upsert(cloudDeckRow(snapshot, true), { onConflict: 'id' }).select().single();
      if (error) throw error;
      snapshot = cloudRowToDeck(data);
      cloudDecks = [snapshot, ...cloudDecks.filter(item => item.id !== snapshot.id)];
      activeDeckId = snapshot.id;
      dirty = false;
      url = cloudDeckUrl(snapshot.id);
      await loadCommunityDecks();
    } catch (error) {
      setStatus(`发布失败：${error.message}`, 'error');
      return;
    }
    } else {
    url = shareUrl(snapshot);
    const records = readStorage(PUBLICATIONS_KEY).map(item => normalizeDeck(item)).filter(Boolean);
    records.unshift({ ...snapshot, id: makeId(), shareUrl: url, publishedAt: new Date().toISOString() });
    writeStorage(PUBLICATIONS_KEY, records.slice(0, 30));
    }
    $('shareLinkOutput').value = url;
    $('shareCompleteLink').value = url;
    $('shareResult').hidden = false;
    renderPublishedDecks();
    try {
      await copyText(url);
      setStatus(`${cloud && authUser ? '卡组已发布到公共广场，' : ''}分享链接已复制。`, 'success');
    } catch {
      setStatus('卡组已分享，请在完成窗口中手动复制链接。', 'success');
    }
    $('shareCompleteDialog').showModal();
  } catch (error) {
    setStatus(`分享失败：${error.message}`, 'error');
  } finally {
    shareBusy = false;
    $('shareCurrent').disabled = false;
    document.querySelectorAll('[data-share-deck]').forEach(button => { button.disabled = false; });
  }
}

async function initializeIncomingDeck() {
  const cloudMatch = location.hash.match(/^#cloud=([0-9a-f-]{36})$/i);
  if (cloudMatch) {
    if (!cloud) {
      setStatus('这是云端卡组链接，但当前网站尚未配置云端服务。', 'error');
      return;
    }
    const { data, error } = await cloud.from('decks').select('*').eq('id', cloudMatch[1]).eq('is_public', true).single();
    if (error || !data) {
      incomingDeck = null;
      renderIncomingDeck();
      setStatus('找不到这副公开卡组，它可能已被取消公开。', 'error');
      return;
    }
    incomingDeck = cloudRowToDeck(data);
    renderIncomingDeck();
    setView('community');
    return;
  }
  const match = location.hash.match(/^#deck=([A-Za-z0-9_-]+)$/);
  if (!match) {
    incomingDeck = null;
    renderIncomingDeck();
    return;
  }
  incomingDeck = decodeDeck(match[1]);
  if (incomingDeck) setView('community');
  else {
    renderIncomingDeck();
    setStatus('分享链接中的卡组数据无效或已经损坏。', 'error');
  }
}

function authCredentials() {
  return {
    displayName: $('authDisplayName').value.trim(),
    email: $('authEmail').value.trim(),
    password: $('authPassword').value
  };
}

function setAuthMessage(message, tone = '') {
  $('authMessage').textContent = message;
  $('authMessage').className = `note ${tone}`;
}

async function initializeCloud() {
  updateAccountUi();
  if (!cloud) return;
  const { data, error } = await cloud.auth.getSession();
  if (error) setStatus(`登录状态读取失败：${error.message}`, 'error');
  authUser = data?.session?.user || null;
  updateAccountUi();
  await refreshCloudDecks();
  cloud.auth.onAuthStateChange((_event, session) => {
    authUser = session?.user || null;
    updateAccountUi();
    setTimeout(() => { void refreshCloudDecks(); }, 0);
  });
}

$('accountButton').addEventListener('click', () => {
  if (!cloud) {
    setStatus('账号界面已经就绪。请先按 SUPABASE_SETUP.md 填写 config.js 并建立数据库。', 'error');
    setView('saved');
    return;
  }
  setAuthMessage('');
  $('authDialog').showModal();
});

$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const { email, password } = authCredentials();
  setAuthMessage('正在登录…');
  const { error } = await cloud.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthMessage(`登录失败：${error.message}`, 'error');
    return;
  }
  $('authDialog').close();
  setStatus('登录成功，正在同步你的卡组。', 'success');
});

$('signUpButton').addEventListener('click', async () => {
  const { displayName, email, password } = authCredentials();
  if (!displayName || !email || password.length < 6) {
    setAuthMessage('请输入公开昵称、有效邮箱和至少 6 位密码。', 'error');
    return;
  }
  setAuthMessage('正在创建账号…');
  const { data, error } = await cloud.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: location.href.split('#')[0],
      data: { display_name: displayName.slice(0, 40) }
    }
  });
  if (error) {
    setAuthMessage(`注册失败：${error.message}`, 'error');
    return;
  }
  if (data.session) {
    $('authDialog').close();
    setStatus('账号创建成功，已经登录。', 'success');
  } else {
    setAuthMessage('注册成功。请打开验证邮件并点击其中的链接，然后返回登录。', 'success');
  }
  void loadSiteStats(false);
});

$('signOutButton').addEventListener('click', async () => {
  const { error } = await cloud.auth.signOut();
  if (error) setStatus(`退出失败：${error.message}`, 'error');
  else {
    authUser = null;
    cloudDecks = [];
    updateAccountUi();
    renderSavedDecks();
    setStatus('已退出账号，本机草稿仍然保留。', 'success');
  }
});

$('gallery').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const article = button.closest('article');
  const id = article?.dataset.id;
  if (!id) return;
  if (button.dataset.show) {
    const card = cardsById.get(id);
    $('largeImage').src = card.image;
    $('largeImage').alt = card.name;
    $('imageCaption').textContent = `${card.code} · ${card.rarity} · ${card.name}`;
    $('lightbox').showModal();
    return;
  }
  try {
    const next = Math.max(0, Math.min(99, (quantities.get(id) || 0) + Number(button.dataset.delta)));
    setQuantity(id, next);
    renderQuantityChange(id);
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

$('gallery').addEventListener('change', event => {
  if (!event.target.matches('input')) return;
  try {
    const id = event.target.closest('article').dataset.id;
    setQuantity(id, Number(event.target.value));
    renderQuantityChange(id);
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

let searchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderGallery, 200); });
for (const id of ['type', 'selected', 'cardSet', 'rarity', 'sort']) $(id).addEventListener('input', renderGallery);
for (const id of ['width', 'height', 'gap', 'marks']) $(id).addEventListener('input', updatePrintStats);
for (const id of ['deckName', 'deckDescription']) $(id).addEventListener('input', () => { markDirty(); $('headerDeckName').textContent = `${$('deckName').value.trim() || '未命名卡组'} · 未保存`; });
$('deckEnvironment').addEventListener('change', () => {
  markDirty();
  renderAll();
  $('deckNote').textContent = `当前使用${environmentLabel($('deckEnvironment').value)}；卡牌图鉴已按该环境过滤。`;
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
for (const button of document.querySelectorAll('[data-go-editor]')) button.addEventListener('click', () => setView('editor'));

for (const button of document.querySelectorAll('[data-deck]')) {
  button.addEventListener('click', () => {
    const deck = presets[button.dataset.deck];
    quantities.clear();
    deck.roles.forEach(id => quantities.set(String(id), (quantities.get(String(id)) || 0) + 1));
    Object.entries(deck.actions).forEach(([id, quantity]) => quantities.set(String(id), quantity));
    $('deckName').value = deck.name;
    $('deckDescription').value = '由网站内置起始卡组载入。';
    activeDeckId = null;
    dirty = true;
    persistDraft();
    $('deckNote').textContent = `已载入：${deck.name}。同卡号的不同稀有度会合并校验。`;
    renderAll();
  });
}

$('newDeck').addEventListener('click', () => {
  quantities.clear();
  $('selected').checked = false;
  $('deckName').value = '未命名卡组';
  $('deckDescription').value = '';
  activeDeckId = null;
  dirty = true;
  persistDraft();
  renderAll();
  setStatus('已建立空白卡组。', 'success');
});

$('all').addEventListener('click', () => {
  cards.forEach(card => quantities.set(String(card.id), 1));
  markDirty();
  $('deckNote').textContent = '已选择全部卡图版本，每个版本 1 份；这通常不是合法卡组，但可以用于整库打印。';
  renderAll();
});

$('clear').addEventListener('click', () => {
  quantities.clear();
  $('selected').checked = false;
  markDirty();
  $('deckNote').textContent = '已清空当前选牌。';
  renderAll();
});

$('applyBatch').addEventListener('click', () => {
  const quantity = Number($('batchQty').value);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    setStatus('批量份数必须是 0–99 的整数。', 'error');
    return;
  }
  const matched = filtered();
  matched.forEach(card => {
    if (quantity) quantities.set(String(card.id), quantity);
    else quantities.delete(String(card.id));
  });
  markDirty();
  $('deckNote').textContent = `已将 ${matched.length} 个匹配版本设为各 ${quantity} 份；其他选择保持不变。`;
  renderAll();
});

for (const id of ['saveCurrent', 'saveCurrentTop']) $(id).addEventListener('click', saveCurrentDeck);
$('goPrint').addEventListener('click', () => setView('print'));
$('shareCurrent').addEventListener('click', () => publishDeck());
$('closeImage').addEventListener('click', () => $('lightbox').close());
$('communityEnvironment').addEventListener('change', () => { communityPage = 0; void loadCommunityDecks({ reset: true }); });
$('refreshCommunity').addEventListener('click', () => { communityCache.delete($('communityEnvironment').value || 'all'); void loadCommunityDecks({ reset: true }); });
$('loadMoreCommunity').addEventListener('click', () => { if (communityHasMore && communityState !== 'loading') void loadCommunityDecks({ reset: false }); });
$('copyCompletedShare').addEventListener('click', async () => {
  try { await copyText($('shareCompleteLink').value); setStatus('分享链接已复制。', 'success'); }
  catch { setStatus('无法访问剪贴板，请手动复制链接。', 'error'); }
});
$('finishShare').addEventListener('click', () => $('shareCompleteDialog').close());

$('savedDecks').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const source = button.dataset.source || 'local';
  const saved = source === 'cloud' ? cloudDecks : readStorage(STORAGE_KEY).map(item => normalizeDeck(item)).filter(Boolean);
  const id = button.dataset.loadDeck || button.dataset.copyDeck || button.dataset.shareDeck || button.dataset.deleteDeck;
  const deck = saved.find(item => item.id === id);
  if (!deck) return;
  if (button.dataset.loadDeck) loadDeck(deck);
  if (button.dataset.copyDeck) loadDeck(deck, true);
  if (button.dataset.shareDeck) publishDeck(deck);
  if (button.dataset.deleteDeck) {
    if (source === 'cloud') {
      const { error } = await cloud.from('decks').delete().eq('id', id);
      if (error) {
        setStatus(`删除失败：${error.message}`, 'error');
        return;
      }
      cloudDecks = cloudDecks.filter(item => item.id !== id);
      communityDecks = communityDecks.filter(item => item.id !== id);
    } else {
      writeStorage(STORAGE_KEY, saved.filter(item => item.id !== id));
    }
    if (activeDeckId === id) activeDeckId = null;
    renderAll();
    setStatus(`已删除“${deck.name}”的${source === 'cloud' ? '云端' : '本机'}记录。`, 'success');
  }
});

$('publishedDecks').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const cloudId = button.dataset.loadCommunity || button.dataset.linkCommunity;
  if (cloudId) {
    const deck = communityDecks.find(item => item.id === cloudId);
    if (!deck) return;
    if (button.dataset.loadCommunity) loadDeck(deck, true);
    if (button.dataset.linkCommunity) {
      try { await copyText(cloudDeckUrl(deck.id)); setStatus('公开卡组链接已复制。', 'success'); }
      catch { setStatus('无法访问剪贴板。', 'error'); }
    }
    return;
  }
  const records = readStorage(PUBLICATIONS_KEY);
  const id = button.dataset.loadPublished || button.dataset.linkPublished || button.dataset.deletePublished;
  const record = records.find(item => item.id === id);
  if (!record) return;
  if (button.dataset.loadPublished) loadDeck(record, true);
  if (button.dataset.linkPublished) {
    try { await copyText(record.shareUrl || shareUrl(record)); setStatus('分享链接已复制。', 'success'); }
    catch { setStatus('无法访问剪贴板，请重新点击“分享当前卡组”。', 'error'); }
  }
  if (button.dataset.deletePublished) {
    writeStorage(PUBLICATIONS_KEY, records.filter(item => item.id !== id));
    renderPublishedDecks();
    setStatus('已删除本机分享记录，已经发出的链接仍然有效。', 'success');
  }
});

$('importLocalDecks').addEventListener('click', async () => {
  if (!cloud || !authUser) return;
  const localDecks = readStorage(STORAGE_KEY).map(item => normalizeDeck(item)).filter(Boolean);
  if (!localDecks.length) return;
  try {
    const rows = localDecks.map(deck => cloudDeckRow({ ...deck, id: makeId() }, false));
    const { error } = await cloud.from('decks').insert(rows);
    if (error) throw error;
    await loadMyCloudDecks();
    setStatus(`已上传 ${localDecks.length} 副本机卡组。原本机记录仍然保留。`, 'success');
  } catch (error) {
    setStatus(`上传本机卡组失败：${error.message}`, 'error');
  }
});

$('incomingDeck').addEventListener('click', event => {
  if (!incomingDeck) return;
  if (event.target.closest('#copyIncoming')) loadDeck(incomingDeck, true);
  if (event.target.closest('#printIncoming')) loadDeck(incomingDeck, true, 'print');
});

function buildSheets() {
  const page = config();
  const items = selectedCards();
  if (!items.length) throw Error('请先选择卡牌。');
  const fragment = document.createDocumentFragment();
  for (let start = 0; start < items.length; start += page.capacity) {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    items.slice(start, start + page.capacity).forEach((card, index) => {
      const x = (210 - (page.columns * page.width + (page.columns - 1) * page.gap)) / 2 + (index % page.columns) * (page.width + page.gap);
      const y = (297 - (page.rows * page.height + (page.rows - 1) * page.gap)) / 2 + Math.floor(index / page.columns) * (page.height + page.gap);
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.cssText = `left:${x}mm;top:${y}mm;width:${page.width}mm;height:${page.height}mm`;
      const image = document.createElement('img');
      image.src = card.image;
      image.alt = `${card.code} ${card.rarity}`;
      slot.append(image);
      sheet.append(slot);
      if ($('marks').checked) {
        for (const markX of [x, x + page.width]) for (const markY of [y, y + page.height]) for (const horizontal of [true, false]) {
          const mark = document.createElement('i');
          mark.className = 'cut';
          const beforeX = markX === x;
          const beforeY = markY === y;
          mark.style.cssText = horizontal
            ? `left:${markX + (beforeX ? -0.9 : 0.2)}mm;top:${markY}mm;width:.7mm;height:.1mm`
            : `left:${markX}mm;top:${markY + (beforeY ? -0.9 : 0.2)}mm;width:.1mm;height:.7mm`;
          sheet.append(mark);
        }
      }
    });
    const label = document.createElement('span');
    label.className = 'page-label';
    label.textContent = `${page.width} × ${page.height} mm | 100% | ${Math.floor(start / page.capacity) + 1} / ${Math.ceil(items.length / page.capacity)}`;
    sheet.append(label);
    fragment.append(sheet);
  }
  $('sheets').replaceChildren(fragment);
}

async function preparePreview() {
  try {
    buildSheets();
    setStatus('正在检查预览图片…');
    await Promise.all([...$('sheets').querySelectorAll('img')].map(image => image.decode()));
    setStatus('');
    $('previewPanel').hidden = false;
    document.body.classList.add('preview-open');
    window.scrollTo(0, 0);
  } catch (error) {
    setStatus(`无法预览：${error.message}`, 'error');
  }
}

async function imageAsJpeg(card, widthMm, heightMm) {
  let response;
  try {
    response = await fetch(new URL(card.image, location.href), { cache: 'force-cache' });
  } catch {
    throw Error(`无法读取卡图 ${card.code}（${card.rarity}）。`);
  }
  if (!response.ok) throw Error(`卡图 ${card.code}（${card.rarity}）加载失败：HTTP ${response.status}`);
  const source = await response.blob();
  const image = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthMm / 25.4 * 300));
  canvas.height = Math.max(1, Math.round(heightMm / 25.4 * 300));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  image.close();
  const jpeg = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('卡图转换失败。')), 'image/jpeg', 0.9));
  canvas.width = 1;
  canvas.height = 1;
  return new Uint8Array(await jpeg.arrayBuffer());
}

function drawCropMarks(pdf, x, y, width, height) {
  pdf.setDrawColor(70);
  pdf.setLineWidth(0.08);
  const inside = 0.2;
  const outside = 0.9;
  for (const markX of [x, x + width]) for (const markY of [y, y + height]) {
    const left = markX === x;
    const top = markY === y;
    pdf.line(markX + (left ? -outside : inside), markY, markX + (left ? -inside : outside), markY);
    pdf.line(markX, markY + (top ? -outside : inside), markX, markY + (top ? -inside : outside));
  }
}

async function downloadPdf() {
  const buttons = [$('print'), $('printPreview')];
  try {
    const page = config();
    const items = selectedCards();
    if (!items.length) throw Error('请先选择卡牌。');
    if (!window.jspdf?.jsPDF) throw Error('PDF 组件未加载，请刷新页面后重试。');
    buttons.forEach(button => { button.disabled = true; });
    const pageCount = Math.ceil(items.length / page.capacity);
    const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
    pdf.setProperties({ title: `${$('deckName').value.trim() || '鸣潮对决'}打印文件`, subject: `${items.length} 张卡牌，${page.width} × ${page.height} mm` });
    const cache = new Map();
    const remaining = new Map();
    items.forEach(card => remaining.set(String(card.id), (remaining.get(String(card.id)) || 0) + 1));
    for (let index = 0; index < items.length; index += 1) {
      const card = items[index];
      const sheetIndex = Math.floor(index / page.capacity);
      if (index && index % page.capacity === 0) pdf.addPage('a4', 'portrait');
      const position = index % page.capacity;
      const x = (210 - (page.columns * page.width + (page.columns - 1) * page.gap)) / 2 + (position % page.columns) * (page.width + page.gap);
      const y = (297 - (page.rows * page.height + (page.rows - 1) * page.gap)) / 2 + Math.floor(position / page.columns) * (page.height + page.gap);
      let jpeg = cache.get(card.id);
      if (!jpeg) {
        setStatus(`正在生成彩色 PDF：${index + 1} / ${items.length} 张…`);
        await new Promise(requestAnimationFrame);
        jpeg = await imageAsJpeg(card, page.width, page.height);
        cache.set(card.id, jpeg);
      }
      pdf.addImage(jpeg, 'JPEG', x, y, page.width, page.height, `card-${card.id}`, 'FAST');
      const left = remaining.get(String(card.id)) - 1;
      remaining.set(String(card.id), left);
      if (!left) cache.delete(card.id);
      if ($('marks').checked) drawCropMarks(pdf, x, y, page.width, page.height);
      if (position === page.capacity - 1 || index === items.length - 1) {
        pdf.setFontSize(7);
        pdf.setTextColor(90);
        pdf.text(`${page.width} x ${page.height} mm | 100% | ${sheetIndex + 1} / ${pageCount}`, 10, 293);
      }
    }
    setStatus('正在准备下载…');
    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = ($('deckName').value.trim() || '鸣潮对决卡组').replace(/[\\/:*?"<>|]/g, '_');
    link.href = url;
    link.download = `${safeName}_${items.length}张_${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus(`已生成 ${pageCount} 页彩色 PDF，请查看浏览器下载记录。`, 'success');
  } catch (error) {
    setStatus(`无法生成 PDF：${error.message}`, 'error');
  } finally {
    buttons.forEach(button => { button.disabled = !selectedCards().length; });
  }
}

$('preview').addEventListener('click', preparePreview);
$('print').addEventListener('click', downloadPdf);
$('printPreview').addEventListener('click', downloadPdf);
$('closePreview').addEventListener('click', () => {
  $('previewPanel').hidden = true;
  document.body.classList.remove('preview-open');
});

if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'set_deck_quantities',
      description: '批量设置当前《鸣潮：对决》卡组中具体卡图版本的数量。',
      inputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, quantity: { type: 'integer', minimum: 0, maximum: 99 } }, required: ['id', 'quantity'], additionalProperties: false } } },
        required: ['items'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        if (!Array.isArray(input?.items) || input.items.some(item => !cardsById.has(String(item.id)) || !Number.isInteger(item.quantity) || item.quantity < 0 || item.quantity > 99)) throw Error('卡图版本或份数无效');
        input.items.forEach(item => setQuantity(String(item.id), item.quantity));
        renderAll();
        const analysis = analyzeDeck();
        return { roleTotal: analysis.roleTotal, actionTotal: analysis.actionTotal, errors: analysis.errors };
      }
    })).catch(() => {});
  } catch {}
}

const rarities = [...new Set(cards.map(card => card.rarity))].sort((a, b) =>
  (a.match(/★/g) || []).length - (b.match(/★/g) || []).length || a.localeCompare(b)
);
for (const rarity of rarities) {
  const option = document.createElement('option');
  option.value = rarity;
  option.textContent = `${rarity}（${cards.filter(card => card.rarity === rarity).length}）`;
  $('rarity').append(option);
}

restoreDraft();
renderAll();
renderSavedDecks();
renderPublishedDecks();
renderIncomingDeck();
void initializeCloud();
void initializeIncomingDeck();
void initializeSiteStats();
setInterval(() => { if (!document.hidden) void loadSiteStats(false); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadSiteStats(false); });
window.addEventListener('hashchange', () => { void initializeIncomingDeck(); });
window.addEventListener('pagehide', persistDraftNow);
