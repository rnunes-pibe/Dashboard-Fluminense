const DASHBOARD_VERSION = '3.2.56';

const CONFIG = Object.freeze({
  googleSheetsCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTVyyhMTbQRPjb1lXdljnsi6kjWt7mU5xKEeZRB24-Ic5hZKzkZCG9gIYvlN81CXVpd0SGc6e0XW18b/pub?gid=1810912358&single=true&output=csv",
  classicosCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTW1huagd5Q9phZyCJE3fit-z1Is8ny15NpTMB1KiHB_wNAopeF9-mecdx0cH4BidxqFS9vTLB6UOvc/pub?gid=1492939094&single=true&output=csv",
  capacidadeSulPagantes: 20000,
  tablePageSize: 40,
  searchDebounceMs: 180,
  fallbackYear: new Date().getFullYear(),
  cacheKey: 'ffc-dashboard-v2.1-cache',
  cacheVersion: 1,
  urlStateVersion: '1',
  fetchTimeoutMs: 15000
});
const GOOGLE_SHEETS_CSV_URL = CONFIG.googleSheetsCsvUrl;
const CLASSICOS_CSV_URL = CONFIG.classicosCsvUrl;

let MATCHES_DATA = [];
let CLASSICOS_DATA = [];

let selectedState = {
  temporada: [], competicao: [], adversario: [], estadio: [], dia: [], horario: [],
  mando: [], 
  presente: []
};

const classicosState = { competicao: [], adversario: [], presente: [], minAno: null, maxAno: null };

let activeCharts = {};
let filteredMatches = [];
let tableCurrentPage = 1;
const tablePageSize = CONFIG.tablePageSize;
let searchDebounceTimer = null;
let mainTableSort = { key: 'date', direction: 'desc' };
let classicosTableSort = { key: 'date', direction: 'desc' };
let currentFilteredClassicos = [];
let semRivaisAtivo = false;
const RIVAIS_RAPIDOS = ['flamengo', 'botafogo', 'vasco'];
function isRivalRapido(adversario) {
  const nome = normalizeComparable(adversario);
  return RIVAIS_RAPIDOS.some(rival => nome.includes(rival));
}

// ============================================================
// V3.0 — CAMADA DE UTILITÁRIOS / PRÉ-PROCESSAMENTO
// ============================================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
}

function parseCsv(csvText) {
  return new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      complete: results => {
        if (results.errors?.length) {
          console.warn('Avisos no CSV:', results.errors);
        }
        resolve(results);
      },
      error: reject
    });
  });
}

function setUpdateStatus(message, isError = false) {
  const el = document.getElementById('last-update-time');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('text-amber-400', isError);
}

function setLoadingState(isLoading) {
  const button = document.getElementById('update-data-button');
  const label = document.getElementById('update-data-label');
  if (button) {
    button.disabled = isLoading;
    button.classList.toggle('opacity-60', isLoading);
    button.classList.toggle('cursor-wait', isLoading);
  }
  if (label) label.textContent = isLoading ? 'Atualizando...' : 'Atualizar';
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeComparable(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeYesNo(value) {
  return normalizeComparable(value) === 'sim' ? 'Sim' : 'Não';
}

function hasAnyHeader(headers, aliases) {
  const normalized = new Set(headers.map(normalizeComparable));
  return aliases.some(alias => normalized.has(normalizeComparable(alias)));
}

function validateSheetStructure(results, schema, label) {
  const headers = results?.meta?.fields || Object.keys(results?.data?.[0] || {});
  const missing = schema.filter(group => !hasAnyHeader(headers, group.aliases));
  if (missing.length) {
    throw new Error(`${label}: coluna(s) obrigatória(s) não encontrada(s): ${missing.map(g => g.label).join(', ')}`);
  }
  return true;
}

const MAIN_SHEET_SCHEMA = Object.freeze([
  { label: 'Data', aliases: ['Data'] },
  { label: 'Placar', aliases: ['Placar'] },
  { label: 'Temporada/Ano', aliases: ['Temporada', 'Ano'] },
  { label: 'Competição/Torneio', aliases: ['Competição', 'Torneio'] },
  { label: 'Adversário', aliases: ['Adversário'] },
  { label: 'Estádio', aliases: ['Estádio'] }
]);

const CLASSICOS_SHEET_SCHEMA = Object.freeze([
  { label: 'Data', aliases: ['Data'] },
  { label: 'Adversário', aliases: ['Adversário', 'Adversario', 'Clube'] },
  { label: 'Competição/Torneio', aliases: ['Competição', 'Torneio', 'Competicao'] }
]);

function validateParsedData(matches, classicos) {
  if (!Array.isArray(matches) || matches.length === 0) throw new Error('Base principal sem partidas válidas');
  if (!Array.isArray(classicos) || classicos.length === 0) throw new Error('Base de clássicos sem partidas válidas');
}

function collectDataWarnings(matches, classicos) {
  const warnings = [];
  matches.forEach(m => {
    if (!Number.isFinite(m.ano) || m.ano < 1900 || m.ano > CONFIG.fallbackYear + 1) warnings.push(`Ano suspeito: ${m.id}`);
    if (m.pub !== null && m.pub < 0) warnings.push(`Público negativo: ${m.id}`);
    if (m.sul !== null && (m.sul < 0 || m.sul > CONFIG.capacidadeSulPagantes)) warnings.push(`Sul Pagantes fora da faixa: ${m.id}`);
    if (m.gf === null || m.ga === null) warnings.push(`Placar não interpretado: ${m.id}`);
  });
  classicos.forEach(c => {
    if (!Number.isFinite(c.ano) || c.ano < 1900 || c.ano > CONFIG.fallbackYear + 1) warnings.push(`Ano suspeito em clássico: ${c.id}`);
    if (c.sul !== null && (c.sul < 0 || c.sul > CONFIG.capacidadeSulPagantes)) warnings.push(`Sul Pagantes fora da faixa em clássico: ${c.id}`);
  });
  return warnings;
}

function saveValidCache(matches, classicos, updatedAt, warningsCount) {
  try {
    localStorage.setItem(CONFIG.cacheKey, JSON.stringify({
      version: CONFIG.cacheVersion,
      updatedAt,
      warningsCount,
      matches,
      classicos
    }));
  } catch (err) {
    console.warn('Não foi possível salvar o cache local:', err);
  }
}

function loadValidCache() {
  try {
    const raw = localStorage.getItem(CONFIG.cacheKey);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (cache?.version !== CONFIG.cacheVersion) return null;
    validateParsedData(cache.matches, cache.classicos);
    return cache;
  } catch (err) {
    console.warn('Cache local inválido ou indisponível:', err);
    return null;
  }
}

function applyLoadedData(matches, classicos) {
  MATCHES_DATA = matches;
  CLASSICOS_DATA = classicos;
  if (document.getElementById('view-rivais') && !document.getElementById('view-rivais').classList.contains('hidden')) renderRivalsInsights();
  updateDynamicYearRange();
  applyFilters();
  initClassicosSlider();
  applyClassicosFilters();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function describeUpdateError(err) {
  if (!navigator.onLine) return 'Sem conexão com a internet';
  if (err?.name === 'AbortError') return 'Tempo de resposta excedido';

  const message = normalizeText(err?.message || '');
  const comparable = normalizeComparable(message);
  if (comparable.includes('comunicacao com as bases') || comparable.includes('http')) return 'Erro ao acessar a planilha';
  if (comparable.includes('coluna(s) obrigatoria(s)') || comparable.includes('base principal vazia') || comparable.includes('base de classicos vazia') || comparable.includes('dados') || comparable.includes('valid')) return 'Dados recebidos inválidos';
  if (err instanceof TypeError) return 'Não foi possível conectar às planilhas';
  return message ? `Falha na atualização: ${message}` : 'Falha na atualização';
}

function debouncedApplyFilters() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    applyFilters();
  }, CONFIG.searchDebounceMs);
}

function normalizeAdv(a) {
  if (!a) return "";
  const s = a.toLowerCase().trim();
  if (s.includes('vasco')) return 'vasco';
  if (s.includes('flamengo')) return 'flamengo';
  if (s.includes('botafogo')) return 'botafogo';
  return s;
}

function computeTimestamp(d) {
  if (!d || d === "-") return 0;
  const parts = d.split(/[-/.]/);
  if (parts.length === 3) {
    const y = parts[0].length === 4 ? parseInt(parts[0], 10) : (parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10));
    const m = parseInt(parts[1], 10) - 1;
    const day = parts[0].length === 4 ? parseInt(parts[2], 10) : parseInt(parts[0], 10);
    return new Date(y, m, day).getTime();
  }
  return 0;
}

function computeSortDate(str) {
  if (!str || str === "-") return new Date(CONFIG.fallbackYear, 0, 1).getTime();
  const p = str.split(/[-/]/);
  if (p.length === 3) {
    if (p[0].length === 4) return new Date(p[0], p[1] - 1, p[2]).getTime();
    return new Date(p[2], p[1] - 1, p[0]).getTime();
  }
  return new Date(CONFIG.fallbackYear, 0, 1).getTime();
}

function parseScore(placarStr, normalizeHyphen = false) {
  if (!placarStr) return { gf: null, ga: null };
  let clean = String(placarStr);
  if (normalizeHyphen) {
    clean = clean.toLowerCase().replace(/\s+/g, '').replace('-', 'x');
  }
  const parts = clean.split('x').map(p => parseInt(p.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { gf: parts[0], ga: parts[1] };
  }
  return { gf: null, ga: null };
}

function parseNumber(val) {
  if (val === null || val === undefined || val === "" || val === "-") return null;
  if (typeof val === 'number') return val;
  const cleanStr = String(val).replace(/\./g, '').replace(/,/g, '.').trim();
  const num = Number(cleanStr);
  return isNaN(num) ? null : num;
}

function isValidMatch(placar) {
  if (!placar) return false;
  const str = String(placar).trim().toLowerCase();
  if (str === "-" || str === "" || str.includes("a realizar") || str.includes("adiado")) return false;
  return true;
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n) || n === 0) return "-";
  return Math.round(n).toLocaleString('pt-BR');
}

document.addEventListener('click', (e) => {
  const isInside = e.target.closest('[id^="dropdown-container-"], [id^="classicos-dropdown-container-"]');
  if (!isInside) document.querySelectorAll('.ms-dropdown-menu').forEach(p => p.classList.add('hidden'));
});

function markActiveTabs(ids, activeId) {
  ids.forEach(id => {
    const button = document.getElementById(id);
    if (button) {
      button.dataset.active = String(id === activeId);
      button.setAttribute('aria-selected', String(id === activeId));
    }
  });
}

function switchTableTab(tab) {
  markActiveTabs(['tab-inner-catalogo', 'tab-inner-estatisticas'], tab === 'catalogo' ? 'tab-inner-catalogo' : 'tab-inner-estatisticas');
  const contentCatalogo = document.getElementById('content-catalogo');
  const contentEstatisticas = document.getElementById('content-estatisticas');
  const btnCatalogo = document.getElementById('tab-inner-catalogo');
  const btnEstatisticas = document.getElementById('tab-inner-estatisticas');
  const searchContainer = document.getElementById('search-container-catalogo');

  if (tab === 'catalogo') {
    contentCatalogo.classList.remove('hidden');
    contentEstatisticas.classList.add('hidden');
    btnCatalogo.className = "px-4 py-2 text-xs font-bold rounded-md bg-[#C5A059] text-[#0A120F] transition whitespace-nowrap";
    btnEstatisticas.className = "px-4 py-2 text-xs font-bold text-white/70 hover:text-white rounded-md transition whitespace-nowrap hover:bg-white/5";
    if (searchContainer) searchContainer.style.display = 'block';
  } else {
    contentCatalogo.classList.add('hidden');
    contentEstatisticas.classList.remove('hidden');
    btnEstatisticas.className = "px-4 py-2 text-xs font-bold rounded-md bg-[#C5A059] text-[#0A120F] transition whitespace-nowrap";
    btnCatalogo.className = "px-4 py-2 text-xs font-bold text-white/70 hover:text-white rounded-md transition whitespace-nowrap hover:bg-white/5";
    if (searchContainer) searchContainer.style.display = 'none';
  }
}

function switchClassicosTableTab(tab) {
  markActiveTabs(['tab-classicos-catalogo', 'tab-classicos-estatisticas'], tab === 'catalogo' ? 'tab-classicos-catalogo' : 'tab-classicos-estatisticas');
  const contentCatalogo = document.getElementById('content-classicos-catalogo');
  const contentEstatisticas = document.getElementById('content-classicos-estatisticas');
  const btnCatalogo = document.getElementById('tab-classicos-catalogo');
  const btnEstatisticas = document.getElementById('tab-classicos-estatisticas');

  if (tab === 'catalogo') {
    contentCatalogo.classList.remove('hidden');
    contentEstatisticas.classList.add('hidden');
    btnCatalogo.className = "px-4 py-2 text-xs font-bold rounded-md bg-[#C5A059] text-[#0A120F] transition whitespace-nowrap";
    btnEstatisticas.className = "px-4 py-2 text-xs font-bold text-white/70 hover:text-white rounded-md transition whitespace-nowrap hover:bg-white/5";
  } else {
    contentCatalogo.classList.add('hidden');
    contentEstatisticas.classList.remove('hidden');
    btnEstatisticas.className = "px-4 py-2 text-xs font-bold rounded-md bg-[#C5A059] text-[#0A120F] transition whitespace-nowrap";
    btnCatalogo.className = "px-4 py-2 text-xs font-bold text-white/70 hover:text-white rounded-md transition whitespace-nowrap hover:bg-white/5";
  }
}

function switchTab(tabName) {
  markActiveTabs(['tab-btn-capa', 'tab-btn-estadio', 'tab-btn-classicos'], 'tab-btn-' + tabName);
  document.getElementById('view-rivais')?.classList.add('hidden');
  document.getElementById('rivals-menu')?.classList.add('hidden');
  const viewCapa = document.getElementById('view-capa');
  const viewEstadio = document.getElementById('view-estadio');
  const viewClassicos = document.getElementById('view-classicos');

  const btnCapa = document.getElementById('tab-btn-capa');
  const btnEstadio = document.getElementById('tab-btn-estadio');
  const btnClassicos = document.getElementById('tab-btn-classicos');

  viewCapa.classList.add('hidden');
  viewEstadio.classList.add('hidden');
  if (viewClassicos) viewClassicos.classList.add('hidden');

  btnCapa.className = "px-3 py-1.5 rounded-md text-xs font-bold transition text-white/70 hover:text-white";
  btnEstadio.className = "px-3 py-1.5 rounded-md text-xs font-bold transition text-white/70 hover:text-white";
  if (btnClassicos) btnClassicos.className = "px-3 py-1.5 rounded-md text-xs font-bold transition text-white/70 hover:text-white";

  if (tabName === 'capa') {
    viewCapa.classList.remove('hidden');
    btnCapa.className = "px-3 py-1.5 rounded-md text-xs font-bold transition bg-[#C5A059] text-[#0A120F]";
  } else if (tabName === 'estadio') {
    viewEstadio.classList.remove('hidden');
    btnEstadio.className = "px-3 py-1.5 rounded-md text-xs font-bold transition bg-[#C5A059] text-[#0A120F]";
    setTimeout(() => { applyFilters(); }, 50);
  } else if (tabName === 'classicos') {
    if (viewClassicos) viewClassicos.classList.remove('hidden');
    if (btnClassicos) btnClassicos.className = "px-3 py-1.5 rounded-md text-xs font-bold transition bg-[#C5A059] text-[#0A120F]";
    setTimeout(() => { applyClassicosFilters(); }, 50);
  }
  if (window.lucide) lucide.createIcons();
}

async function fetchLiveGoogleSheet() {
  if (fetchLiveGoogleSheet.isRunning) return;
  fetchLiveGoogleSheet.isRunning = true;
  setLoadingState(true);
  setUpdateStatus('Sincronizando com nuvem...');

  try {
    const cacheBuster = Date.now();
    const urlMain = `${GOOGLE_SHEETS_CSV_URL}&_=${cacheBuster}`;
    const urlClassicos = `${CLASSICOS_CSV_URL}&_=${cacheBuster}`;

    const [responseMain, responseClassicos] = await Promise.all([fetchWithTimeout(urlMain), fetchWithTimeout(urlClassicos)]);
    if (!responseMain.ok || !responseClassicos.ok) {
      throw new Error(`Erro na comunicação com as bases (${responseMain.status}/${responseClassicos.status})`);
    }

    const [csvTextMain, csvTextClassicos] = await Promise.all([responseMain.text(), responseClassicos.text()]);
    const [mainResults, classicosResults] = await Promise.all([parseCsv(csvTextMain), parseCsv(csvTextClassicos)]);

    validateSheetStructure(mainResults, MAIN_SHEET_SCHEMA, 'Base principal');
    validateSheetStructure(classicosResults, CLASSICOS_SHEET_SCHEMA, 'Base de clássicos');

    const rows = mainResults.data;
    if (!rows || rows.length === 0) throw new Error('Base principal vazia');
    const parsedMatches = [];
    rows.forEach((row, idx) => {
      const placar = row['Placar'] || '-';
      const resultado = normalizeText(row['Resultado']);
      if (normalizeComparable(resultado).includes('a realizar')) return;
      if (!isValidMatch(placar)) return;

      const season = row['Temporada'] || row['Ano'];
      if (String(season).trim() === '2008') return;

      const dataVal = row['Data'];
      const dtStr = dataVal ? normalizeText(dataVal).slice(0, 10) : '';
      const diaSem = normalizeText(row['Dia da Semana']) || '-';
      const hrStr = normalizeText(row['Horário'] || row['Hora']) || '-';
      const parsedHour = hrStr !== '-' ? parseInt(hrStr.split(':')[0], 10) : NaN;
      const hrInt = Number.isNaN(parsedHour) ? null : parsedHour;

      let mando = normalizeText(row['Mando'] || row['Casa/Fora/Neutro']) || '-';
      if (mando === 'C') mando = 'Mandante';
      else if (mando === 'F') mando = 'Visitante';
      else if (mando === 'N') mando = 'Neutro';

      const comp = normalizeText(row['Competição'] || row['Torneio']) || '-';
      if (normalizeComparable(comp).includes('amistoso')) return;

      const adv = normalizeText(row['Adversário']) || 'A Definir';
      const estadio = normalizeText(row['Estádio']) || 'A Definir';
      const presVal = row['Presente?'] || row['Presente'] || 'Não';

      if (dtStr || comp !== '-' || adv !== 'A Definir') {
        const placarStr = normalizeText(placar);
        const score = parseScore(placarStr, false);
        const isMaracanaNorm = normalizeComparable(estadio) === 'maracana';
        parsedMatches.push({
          id: normalizeText(row['ID Jogo']) || `FLU-${String(idx + 1).padStart(3, '0')}`,
          ano: Number(season) || (dtStr ? parseInt(dtStr.slice(0, 4), 10) : CONFIG.fallbackYear),
          data: dtStr,
          timestamp: computeTimestamp(dtStr),
          hora: hrStr,
          hNum: hrInt,
          dia: diaSem,
          torneio: comp,
          mando,
          adv,
          advLower: adv.toLowerCase(),
          advNorm: normalizeAdv(adv),
          estadio,
          isMaracanaNorm,
          placar: placarStr,
          gf: score.gf,
          ga: score.ga,
          pub: parseNumber(row['Público Total']),
          pubVis: parseNumber(row['Público Visitante (Flu)'] || row['Público Visitante']),
          sul: parseNumber(row['Sul Pagantes']),
          presente: normalizeYesNo(presVal)
        });
      }
    });

    const classicosRows = classicosResults.data;
    if (!classicosRows || classicosRows.length === 0) throw new Error('Base de clássicos vazia');
    const parsedClassicos = [];
    classicosRows.forEach((row, idx) => {
      const dataStr = normalizeText(row['Data']) || '-';
      let anoClassico = CONFIG.fallbackYear;
      if (dataStr !== '-') {
        const parts = dataStr.split(/[-/]/);
        if (parts.length >= 3) anoClassico = parts[0].length === 4 ? parseInt(parts[0], 10) : parseInt(parts[2], 10);
        else anoClassico = parseInt(dataStr.slice(-4), 10) || CONFIG.fallbackYear;
      }

      let fGols = null, aGols = null;
      for (const key in row) {
        const k = normalizeComparable(key);
        if (k === 'fluminense gols') fGols = row[key];
        if (k === 'adversario gols') aGols = row[key];
      }

      let placar = '-';
      if (fGols !== null && fGols !== '' && fGols !== '-' && aGols !== null && aGols !== '' && aGols !== '-') placar = `${fGols}x${aGols}`;
      else placar = row['Placar'] || row['Resultado'] || row['Placar Jogo'] || '-';

      const status = normalizeText(row['Status'] || row['Resultado']);
      const statusNorm = normalizeComparable(status);
      if (statusNorm.includes('a realizar') || statusNorm.includes('adiado')) return;
      if (!isValidMatch(placar)) return;

      const presVal = row['Rodolfo presente?'] || row['Presente?'] || row['Presente'] || row['Estádio?'] || 'Não';
      const advName = normalizeText(row['Adversário'] || row['Adversario'] || row['Clube']) || '-';
      const placarStr = normalizeText(placar);
      const score = parseScore(placarStr, true);

      parsedClassicos.push({
        id: idx,
        adv: advName,
        advNorm: normalizeAdv(advName),
        data: dataStr,
        timestamp: computeTimestamp(dataStr),
        sortTime: computeSortDate(dataStr),
        ano: anoClassico,
        torneio: normalizeText(row['Competição'] || row['Torneio'] || row['Competicao']) || '-',
        estadio: normalizeText(row['Estádio'] || row['Estadio'] || row['Local']) || '-',
        placar: placarStr,
        gf: score.gf,
        ga: score.ga,
        presente: normalizeText(presVal),
        sul: parseNumber(row['Sul Pagantes'])
      });
    });

    validateParsedData(parsedMatches, parsedClassicos);
    const warnings = collectDataWarnings(parsedMatches, parsedClassicos);
    if (warnings.length) console.warn(`Validação concluída com ${warnings.length} alerta(s):`, warnings);

    applyLoadedData(parsedMatches, parsedClassicos);
    const now = new Date();
    saveValidCache(parsedMatches, parsedClassicos, now.toISOString(), warnings.length);
    const suffix = warnings.length ? ` • ${warnings.length} alerta(s) de consistência` : '';
    setUpdateStatus(`Última atualização: ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR')}${suffix}`);
  } catch (err) {
    console.warn('Erro ao buscar/validar a base:', err);
    const cache = loadValidCache();
    if (cache) {
      applyLoadedData(cache.matches, cache.classicos);
      const cachedAt = new Date(cache.updatedAt);
      const cachedLabel = Number.isNaN(cachedAt.getTime()) ? 'data desconhecida' : `${cachedAt.toLocaleDateString('pt-BR')} às ${cachedAt.toLocaleTimeString('pt-BR')}`;
      const cause = describeUpdateError(err);
      setUpdateStatus(`${cause}. Exibindo última base válida de ${cachedLabel}.`, true);
    } else {
      setUpdateStatus(`${describeUpdateError(err)}.`, true);
    }
  } finally {
    fetchLiveGoogleSheet.isRunning = false;
    setLoadingState(false);
  }
}

const URL_FILTER_KEYS = Object.freeze({
  temporada: 'temporada', competicao: 'competicao', adversario: 'adversario', estadio: 'estadio',
  dia: 'dia', horario: 'horario', mando: 'mando', presente: 'presente'
});

function restoreFiltersFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    Object.entries(URL_FILTER_KEYS).forEach(([stateKey, paramKey]) => {
      const values = params.getAll(paramKey).map(normalizeText).filter(Boolean);
      if (values.length) selectedState[stateKey] = [...new Set(values)];
    });
    semRivaisAtivo = params.get('semRivais') === '1';
    updateSemRivaisButton();
    const search = normalizeText(params.get('busca') || '');
    const searchBox = document.getElementById('search-adversario');
    if (searchBox && search) searchBox.value = search;
  } catch (err) {
    console.warn('Não foi possível restaurar os filtros da URL:', err);
  }
}

function syncFiltersToUrl() {
  try {
    const url = new URL(window.location.href);
    Object.values(URL_FILTER_KEYS).forEach(key => url.searchParams.delete(key));
    url.searchParams.delete('busca');
    url.searchParams.delete('v');
    url.searchParams.delete('semRivais');

    Object.entries(URL_FILTER_KEYS).forEach(([stateKey, paramKey]) => {
      selectedState[stateKey].forEach(value => url.searchParams.append(paramKey, value));
    });
    const searchBox = document.getElementById('search-adversario');
    const search = normalizeText(searchBox?.value || '');
    if (search) url.searchParams.set('busca', search);
    if (semRivaisAtivo) url.searchParams.set('semRivais', '1');

    const hasState = Object.values(selectedState).some(values => values.length > 0) || Boolean(search) || semRivaisAtivo;
    if (hasState) url.searchParams.set('v', CONFIG.urlStateVersion);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) {
    // Alguns navegadores restringem replaceState quando o HTML é aberto diretamente via file://.
    console.warn('Não foi possível refletir os filtros na URL:', err);
  }
}

async function copyFilteredUrl() {
  syncFiltersToUrl();
  const label = document.getElementById('copy-filter-link-label');
  try {
    await navigator.clipboard.writeText(window.location.href);
    if (label) label.textContent = 'Copiado!';
  } catch (err) {
    console.warn('Não foi possível copiar o link automaticamente:', err);
    if (label) label.textContent = 'Use a URL';
  } finally {
    setTimeout(() => { if (label) label.textContent = 'Copiar filtros'; }, 1600);
  }
}

function csvSafeCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportFilteredCsv() {
  if (!filteredMatches.length) {
    setUpdateStatus('Não há partidas no filtro atual para exportar.', true);
    return;
  }

  const headers = ['ID', 'Data', 'Horário', 'Temporada', 'Competição', 'Mando', 'Adversário', 'Estádio', 'Placar', 'Público Total', 'Público Visitante', 'Sul Pagantes', 'Ocupação Sul', 'Presente'];
  const rows = filteredMatches.map(m => [
    m.id, m.data, m.hora, m.ano, m.torneio, m.mando, m.adv, m.estadio, m.placar,
    m.pub ?? '', m.pubVis ?? '', m.sul ?? '',
    m.sul !== null && m.sul !== undefined ? `${((m.sul / CONFIG.capacidadeSulPagantes) * 100).toFixed(1)}%` : '',
    m.presente
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvSafeCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = objectUrl;
  link.download = `fluminense-partidas-filtradas-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function exportClassicosFilteredCsv() {
  const setComp = classicosState.competicao.length > 0 ? new Set(classicosState.competicao) : null;
  const setAdv = classicosState.adversario.length > 0 ? new Set(classicosState.adversario) : null;
  const setPres = classicosState.presente.length > 0 ? new Set(classicosState.presente) : null;

  const filteredClassicos = CLASSICOS_DATA.filter(m => {
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (classicosState.minAno && m.ano < classicosState.minAno) return false;
    if (classicosState.maxAno && m.ano > classicosState.maxAno) return false;
    return true;
  });

  if (!filteredClassicos.length) {
    setUpdateStatus('Não há clássicos no filtro atual para exportar.', true);
    return;
  }

  const headers = ['Data', 'Temporada', 'Adversário', 'Placar', 'Competição', 'Presente'];
  const rows = filteredClassicos.map(m => [
    m.data, m.ano, m.adv, m.placar, m.torneio, m.presente
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvSafeCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = objectUrl;
  link.download = `fluminense-classicos-filtrados-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function updateDynamicYearRange() {
  if (!MATCHES_DATA || MATCHES_DATA.length === 0) return;
  const years = MATCHES_DATA.map(m => m.ano);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  document.querySelectorAll('.dynamic-year-range').forEach(el => { el.textContent = `${minYear}-${maxYear}`; });
}

function toggleDropdown(type) {
  const targetPanel = document.getElementById(`panel-${type}`);
  const isClosed = targetPanel.classList.contains('hidden');
  document.querySelectorAll('.ms-dropdown-menu').forEach(p => p.classList.add('hidden'));
  if (isClosed) targetPanel.classList.remove('hidden');
}

function getMatchesExcluding(excludeDimension) {
  const searchBox = document.getElementById("search-adversario");
  const search = searchBox ? searchBox.value.toLowerCase().trim() : "";

  const setTemp = excludeDimension !== 'temporada' && selectedState.temporada.length > 0 ? new Set(selectedState.temporada) : null;
  const setComp = excludeDimension !== 'competicao' && selectedState.competicao.length > 0 ? new Set(selectedState.competicao) : null;
  const setMando = excludeDimension !== 'mando' && selectedState.mando.length > 0 ? new Set(selectedState.mando) : null;
  const setEst = excludeDimension !== 'estadio' && selectedState.estadio.length > 0 ? new Set(selectedState.estadio) : null;
  const setDia = excludeDimension !== 'dia' && selectedState.dia.length > 0 ? new Set(selectedState.dia) : null;
  const setHor = excludeDimension !== 'horario' && selectedState.horario.length > 0 ? new Set(selectedState.horario) : null;
  const setAdv = excludeDimension !== 'adversario' && selectedState.adversario.length > 0 ? new Set(selectedState.adversario) : null;
  const setPres = excludeDimension !== 'presente' && selectedState.presente.length > 0 ? new Set(selectedState.presente) : null;

  return MATCHES_DATA.filter(m => {
    if (setTemp && !setTemp.has(String(m.ano))) return false;
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setMando && !setMando.has(m.mando)) return false;
    if (setEst && !setEst.has(m.estadio)) return false;
    if (setDia && !setDia.has(m.dia)) return false;
    if (setHor && !setHor.has(m.hora)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (semRivaisAtivo && isRivalRapido(m.adv)) return false;
    if (search && !m.advLower.includes(search)) return false;
    return true;
  });
}

function renderChecklist(type, items, matchingSubset) {
  const container = document.getElementById(`list-${type}`);
  if (!container) return;
  
  if (items.length === 0) {
    container.innerHTML = '<div class="text-[11px] text-white/40 p-2 text-center italic">Nenhuma opção disponível</div>';
    return;
  }

  const counts = {};
  matchingSubset.forEach(m => {
    let val;
    if (type === 'temporada') val = String(m.ano);
    else if (type === 'competicao') val = m.torneio;
    else if (type === 'adversario') val = m.adv;
    else if (type === 'horario') val = m.hora;
    else val = m[type];
    counts[val] = (counts[val] || 0) + 1;
  });

  const checkedSet = new Set(selectedState[type]);
  const html = items.map(item => {
    const count = counts[item.value] || 0;
    const isChecked = checkedSet.has(item.value);
    return `
      <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded-lg cursor-pointer text-xs text-white/90 transition select-none" data-label="${escapeHtml(item.label.toLowerCase())}">
        <div class="flex items-center gap-2 truncate pr-1">
          <input type="checkbox" class="ms-checkbox rounded" value="${escapeHtml(item.value)}" ${isChecked ? 'checked' : ''} data-change-action="filter-checkbox" data-filter="${escapeHtml(type)}">
          <span class="truncate">${escapeHtml(item.label)}</span>
        </div>
        <span class="text-[10px] text-white/40 font-mono shrink-0">${count}</span>
      </label>
    `;
  }).join('');
  
  container.innerHTML = html;
}

function updateAllDropdowns() {
  const mandos = ['Mandante', 'Visitante', 'Neutro'].map(m => ({ value: m, label: m === 'Mandante' ? 'Mandante (Casa)' : m === 'Visitante' ? 'Visitante (Fora)' : 'Campo Neutro' }));
  renderChecklist('mando', mandos, getMatchesExcluding('mando'));

  const years = [...new Set(MATCHES_DATA.map(m => m.ano))].sort((a, b) => b - a);
  renderChecklist('temporada', years.map(y => ({ value: String(y), label: String(y) })), getMatchesExcluding('temporada'));

  const comps = [...new Set(MATCHES_DATA.map(m => m.torneio))].filter(c => c && c !== "-").sort();
  renderChecklist('competicao', comps.map(c => ({ value: c, label: c })), getMatchesExcluding('competicao'));

  const opponents = [...new Set(MATCHES_DATA.map(m => m.adv))].filter(a => a && a !== "-" && a !== "A Definir").sort((a, b) => a.localeCompare(b, 'pt-BR'));
  renderChecklist('adversario', opponents.map(adv => ({ value: adv, label: adv })), getMatchesExcluding('adversario'));

  const validEstadioMatches = getMatchesExcluding('estadio');
  const venues = [...new Set(validEstadioMatches.map(m => m.estadio))].filter(v => v && v !== "-" && v !== "A Definir").sort();
  renderChecklist('estadio', venues.map(v => ({ value: v, label: v })), validEstadioMatches);

  const validDiaMatches = getMatchesExcluding('dia');
  const diasEncontrados = [...new Set(validDiaMatches.map(m => m.dia))].filter(d => d && d !== "-");
  const daysOrder = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'];
  diasEncontrados.sort((a, b) => daysOrder.indexOf(a) - daysOrder.indexOf(b)); 
  renderChecklist('dia', diasEncontrados.map(d => ({ value: d, label: d })), validDiaMatches);

  const validHorarioMatches = getMatchesExcluding('horario');
  const times = [...new Set(validHorarioMatches.map(m => m.hora))].filter(h => h && h !== "-").sort();
  renderChecklist('horario', times.map(h => ({ value: h, label: `${h}h` })), validHorarioMatches);

  const presentes = [...new Set(MATCHES_DATA.map(m => m.presente))].filter(p => p).sort();
  renderChecklist('presente', presentes.map(p => ({ value: p, label: p })), getMatchesExcluding('presente'));
}

function filterDropdownOptions(type, query) {
  const container = document.getElementById(`list-${type}`);
  if (!container) return;
  const q = query.toLowerCase().trim();
  container.querySelectorAll('label').forEach(r => {
    const text = r.getAttribute('data-label') || "";
    r.classList.toggle('hidden', q && !text.includes(q));
  });
}

function onCheckboxChange(type, value, isChecked) {
  if (isChecked) {
    if (!selectedState[type].includes(value)) selectedState[type].push(value);
  } else {
    selectedState[type] = selectedState[type].filter(v => v !== value);
  }
  applyFilters();
}

function selectAllFilter(type, selectAll) {
  const container = document.getElementById(`list-${type}`);
  if (!container) return;
  selectedState[type] = [];
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = selectAll;
    if (selectAll) selectedState[type].push(cb.value);
  });
  applyFilters();
}

function updateFilterLabels() {
  const types = ['mando', 'temporada', 'competicao', 'adversario', 'estadio', 'dia', 'horario', 'presente'];
  types.forEach(t => {
    const count = selectedState[t].length;
    const labelEl = document.getElementById(`label-${t}`);
    if (!labelEl) return;
    const totalItems = document.querySelectorAll(`#list-${t} input[type="checkbox"]`).length;
    if (count === 0) {
      labelEl.textContent = (t === 'mando' || t === 'estadio' || t === 'dia' || t === 'horario' || t === 'adversario' || t === 'presente') ? 'Todos' : 'Todas';
      labelEl.className = 'truncate pr-1 text-white/80';
    } else if (count === totalItems && totalItems > 1) {
      labelEl.textContent = 'Todas Selecionadas';
      labelEl.className = 'truncate pr-1 text-emerald-300 font-semibold';
    } else if (count === 1) {
      labelEl.textContent = selectedState[t][0];
      labelEl.className = 'truncate pr-1 text-[#C5A059] font-semibold';
    } else {
      labelEl.textContent = `${count} selecionados`;
      labelEl.className = 'truncate pr-1 text-[#C5A059] font-semibold';
    }
  });
  renderActiveBadges();
}

function renderActiveBadges() {
  const badgesContainer = document.getElementById('active-badges-list');
  if (!badgesContainer) return;
  badgesContainer.innerHTML = '';
  let hasFilters = false;
  const typeLabels = { mando: 'Mando', temporada: 'Ano', competicao: 'Torneio', adversario: 'Adversário', estadio: 'Estádio', dia: 'Dia', horario: 'Horário', presente: 'Matador' };

  Object.keys(selectedState).forEach(type => {
    if (selectedState[type].length > 0) {
      hasFilters = true;
      selectedState[type].forEach(val => {
        const pill = document.createElement('span');
        pill.className = 'ms-pill text-[11px] px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'text-white/50';
        labelSpan.textContent = `${typeLabels[type]}:`;
        const valueStrong = document.createElement('strong');
        valueStrong.className = 'font-medium';
        valueStrong.textContent = val;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'hover:text-white transition ml-0.5 text-xs font-bold';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => removeFilterItem(type, val));
        pill.append(labelSpan, valueStrong, removeBtn);
        badgesContainer.appendChild(pill);
      });
    }
  });

  if (hasFilters) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'text-[11px] font-semibold text-rose-300 hover:text-white transition ml-2 underline';
    clearBtn.textContent = 'Restaurar Padrão';
    clearBtn.addEventListener('click', resetFilters);
    badgesContainer.appendChild(clearBtn);
  } else {
    badgesContainer.innerHTML = '<span class="text-white/50 italic text-[11px]">Nenhum filtro restritivo aplicado.</span>';
  }
}

function removeFilterItem(type, val) {
  selectedState[type] = selectedState[type].filter(v => v !== val);
  applyFilters();
}

function resetFilters() {
  Object.keys(selectedState).forEach(k => { selectedState[k] = []; });
  selectedState.mando = [];
  semRivaisAtivo = false;
  updateSemRivaisButton();
  document.querySelectorAll('#view-estadio input[type="text"]').forEach(input => input.value = '');
  const searchBox = document.getElementById("search-adversario");
  if (searchBox) searchBox.value = "";
  applyFilters();
}

function updateSemRivaisButton() {
  const btn = document.getElementById('btn-sem-rivais');
  const label = document.getElementById('label-sem-rivais');
  const icon = document.getElementById('icon-sem-rivais');
  if (!btn || !label) return;
  btn.setAttribute('aria-pressed', semRivaisAtivo ? 'true' : 'false');
  label.textContent = semRivaisAtivo ? 'Ativado' : 'Desativado';
  btn.classList.toggle('bg-[#0E4735]', semRivaisAtivo);
  btn.classList.toggle('border-[#C5A059]', semRivaisAtivo);
  label.classList.toggle('text-[#C5A059]', semRivaisAtivo);
  if (icon) icon.setAttribute('data-lucide', semRivaisAtivo ? 'toggle-right' : 'toggle-left');
  if (window.lucide) lucide.createIcons();
}

function toggleSemRivais() {
  semRivaisAtivo = !semRivaisAtivo;
  updateSemRivaisButton();
  applyFilters();
}

function formatK(value, decimals = 0) {
  const n = Number(value) || 0;
  return `${(n / 1000).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}k`;
}

function formatFull(value) {
  return Math.round(Number(value) || 0).toLocaleString('pt-BR');
}

function makeValueLabelsPlugin(id, { decimals = 0, horizontal = false, fontSize = 11, mobileOutside = false, fullValue = false, fullWhenSingleVisible = false } = {}) {
  return {
    id,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = `700 ${fontSize}px 'Plus Jakarta Sans', sans-serif`;
      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#244634' : 'rgba(255,255,255,0.88)';
      ctx.textAlign = horizontal ? 'left' : 'center';
      ctx.textBaseline = horizontal ? 'middle' : 'bottom';
      const visibleDatasetCount = chart.data.datasets.reduce((count, _dataset, datasetIndex) => count + (chart.isDatasetVisible(datasetIndex) ? 1 : 0), 0);
      const useFullValue = fullValue || (fullWhenSingleVisible && visibleDatasetCount === 1);
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (meta.hidden) return;
        meta.data.forEach((element, dataIndex) => {
          const value = Number(dataset.data[dataIndex]);
          if (!Number.isFinite(value) || value <= 0) return;
          if (horizontal) {
            const isMobile = window.matchMedia('(max-width: 767px)').matches;
            const rightReserve = fullValue ? 50 : 34;
            const x = id === 'topVisitanteLabels' ? Math.min(element.x + 8, chart.width - rightReserve) : ((mobileOutside && isMobile) ? element.x + 8 : Math.min(element.x + 6, chartArea.right - rightReserve));
            ctx.fillText(useFullValue ? formatFull(value) : formatK(value, decimals), x, element.y);
          }
          else ctx.fillText(useFullValue ? formatFull(value) : formatK(value, decimals), element.x, Math.max(chartArea.top + 12, element.y - 6));
        });
      });
      ctx.restore();
    }
  };
}

function applyFilters() {
  const searchBox = document.getElementById("search-adversario");
  const search = searchBox ? searchBox.value.toLowerCase().trim() : "";
  
  updateAllDropdowns();
  updateFilterLabels();
  updatePublicFiltersToggleSummary();

  const setTemp = selectedState.temporada.length > 0 ? new Set(selectedState.temporada) : null;
  const setComp = selectedState.competicao.length > 0 ? new Set(selectedState.competicao) : null;
  const setMando = selectedState.mando.length > 0 ? new Set(selectedState.mando) : null;
  const setEst = selectedState.estadio.length > 0 ? new Set(selectedState.estadio) : null;
  const setDia = selectedState.dia.length > 0 ? new Set(selectedState.dia) : null;
  const setHor = selectedState.horario.length > 0 ? new Set(selectedState.horario) : null;
  const setAdv = selectedState.adversario.length > 0 ? new Set(selectedState.adversario) : null;
  const setPres = selectedState.presente.length > 0 ? new Set(selectedState.presente) : null;

  filteredMatches = MATCHES_DATA.filter(m => {
    if (setTemp && !setTemp.has(String(m.ano))) return false;
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setMando && !setMando.has(m.mando)) return false;
    if (setEst && !setEst.has(m.estadio)) return false;
    if (setDia && !setDia.has(m.dia)) return false;
    if (setHor && !setHor.has(m.hora)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (semRivaisAtivo && isRivalRapido(m.adv)) return false;
    if (search && !m.advLower.includes(search)) return false;
    return true;
  });

  tableCurrentPage = 1;
  updateKpis();
  updateCharts();
  renderTable();
  syncFiltersToUrl();
}


function updatePublicFiltersToggleSummary() {
  const countEl = document.getElementById('public-filters-active-count');
  if (!countEl) return;
  const count = mainFilterSummary().length;
  countEl.textContent = count === 1 ? '1 ativo' : `${count} ativos`;
  countEl.hidden = count === 0;
}

let publicFiltersOpenedThisSession = false;

function setPublicFiltersExpanded(expanded) {
  const content = document.getElementById('public-filters-content');
  const button = document.getElementById('public-filters-toggle');
  const label = document.getElementById('public-filters-toggle-label');
  if (!content || !button || !label) return;
  content.hidden = !expanded;
  button.setAttribute('aria-expanded', String(expanded));
  button.classList.toggle('is-open', expanded);
  if (expanded && window.matchMedia('(max-width: 767px)').matches) publicFiltersOpenedThisSession = true;
  button.classList.toggle('attention-seen', publicFiltersOpenedThisSession);
  label.textContent = expanded ? 'Ocultar filtros' : 'Ver filtros';
  if (!expanded) document.querySelectorAll('.ms-dropdown-menu').forEach(menu => menu.classList.add('hidden'));
}

function togglePublicFilters() {
  const content = document.getElementById('public-filters-content');
  if (!content) return;
  setPublicFiltersExpanded(content.hidden);
}

function initPublicFiltersPanel() {
  setPublicFiltersExpanded(!window.matchMedia('(max-width: 767px)').matches);
  updatePublicFiltersToggleSummary();
}

function toggleDataNotice() {
  const content = document.getElementById('data-notice-content');
  const button = document.getElementById('data-notice-toggle');
  const label = document.getElementById('data-notice-toggle-label');
  if (!content || !button || !label) return;
  const opening = content.hidden;
  content.hidden = !opening;
  button.setAttribute('aria-expanded', String(opening));
  label.textContent = opening ? 'Ocultar avisos' : 'Ver avisos';
  button.classList.toggle('is-open', opening);
  if (opening) button.classList.add('attention-seen');
}

function formatShortMatchDate(match) {
  if (!match || !match.data || match.data === '-') return '-';
  const timestamp = match.timestamp || computeTimestamp(match.data);
  if (!timestamp) return match.data;
  const date = new Date(timestamp);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

function formatCompactMatchDate(match) {
  if (!match || !match.data || match.data === '-') return '-';
  const timestamp = match.timestamp || computeTimestamp(match.data);
  if (!timestamp) return match.data;
  const date = new Date(timestamp);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

function sequenceResponsiveDate(match) {
  return `<span class="sequence-date sequence-date-mobile">${escapeHtml(formatShortMatchDate(match))}</span><span class="sequence-date sequence-date-desktop">${escapeHtml(formatCompactMatchDate(match))}</span>`;
}

function formatMatchPeriod(startMatch, endMatch) {
  if (!startMatch || !endMatch) return '-';
  const start = formatShortMatchDate(startMatch);
  const end = formatShortMatchDate(endMatch);
  return start === end ? start : `${start} a ${end}`;
}

function calculateLongestStreak(matches, predicate) {
  const chronological = matches
    .filter(m => getMatchResult(m))
    .slice()
    .sort((a, b) => (a.timestamp || computeTimestamp(a.data)) - (b.timestamp || computeTimestamp(b.data)));
  let best = [], current = [];
  chronological.forEach(match => {
    if (predicate(getMatchResult(match))) {
      current.push(match);
      if (current.length > best.length) best = current.slice();
    } else current = [];
  });
  return best;
}

let performanceStreaks = { wins: [], unbeaten: [] };
let expandedStreak = null;

function recentRateColor(rate) {
  if (rate < 40) return '#fb3f61';
  if (rate < 50) return '#fb923c';
  if (rate < 60) return '#facc15';
  if (rate < 70) return '#6ee7b7';
  return '#10c98b';
}

function compactCompetitionName(value) {
 const original=String(value||'-');
 const normalized=original.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/serie b/.test(normalized)&&/brasileir|campeonato brasileiro/.test(normalized))return 'Brasileirão B';
 if(/brasileir|campeonato brasileiro/.test(normalized))return 'Brasileirão';
 if(/carioca/.test(normalized))return 'Carioca';
 if(/rio.sao.paulo/.test(normalized))return 'Rio-SP';
 if(/libertadores/.test(normalized))return 'Libertadores';
 if(/sul.americana/.test(normalized))return 'Sul-Americana';
 if(/supercopa/.test(normalized))return 'Supercopa';
 if(/copa do brasil/.test(normalized))return 'Copa do Brasil';
 if(/torneio inicio/.test(normalized))return 'Torneio Início';
 if(/estadual/.test(normalized))return 'Estadual';
 return original;
}
function sharedDetailsHeader() {
 return '<div class="shared-match-row shared-match-head"><span>DATA</span><span>ADVERSÁRIO</span><span>PLACAR</span><span>COMPETIÇÃO</span></div>';
}
function sharedDetailsRow(date, opponent, score, competition, result) {
 const res=String(result||'E').toUpperCase();
 const cls=['V','E','D'].includes(res)?res:'E';
 return '<div class="shared-match-row"><span class="shared-match-date">'+escapeHtml(date||'-')+'</span>'+
 '<span class="shared-match-opponent" title="'+escapeHtml(opponent||'-')+'">'+escapeHtml(opponent||'-')+'</span>'+
 '<span class="shared-match-score shared-match-score-'+cls+'">'+escapeHtml(score||'-')+'</span>'+
 '<span class="shared-match-comp" title="'+escapeHtml(competition||'-')+'">'+escapeHtml(compactCompetitionName(competition))+'</span></div>';
}
function sharedMatchDate(m) { return formatShortMatchDate(m); }
function rivalsFullDate(m) {
 const t=Number(m.time);
 if(Number.isFinite(t)&&t>0) {
   const d=new Date(t);
   return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
 }
 const raw=String(m.date||'');
 const slash=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 return slash?slash[1].padStart(2,'0')+'/'+slash[2].padStart(2,'0')+'/'+slash[3]:raw;
}
function renderStreakMatches(type) {
 const container=document.getElementById(`streak-${type}-matches`);
 if(!container)return;
 const matches=performanceStreaks[type] || [];
 if(!matches.length){container.textContent='Nenhuma partida para exibir.';return;}
 const ordered=matches.slice().sort((a,b)=>(a.timestamp||computeTimestamp(a.data))-(b.timestamp||computeTimestamp(b.data)));
 container.innerHTML=sharedDetailsHeader()+ordered.map(m=>sharedDetailsRow(sharedMatchDate(m),m.adv,m.placar,m.torneio,getMatchResult(m))).join('');
}

function syncStreakExpansion() {
  ['wins', 'unbeaten'].forEach(type => {
    const button = document.querySelector(`[data-action="toggle-streak-matches"][data-streak="${type}"]`);
    const container = document.getElementById(`streak-${type}-matches`);
    const open = expandedStreak === type;
    if (button) {
      button.setAttribute('aria-expanded', String(open));
      button.innerHTML = open ? 'Ocultar partidas <span aria-hidden="true">⌃</span>' : 'Ver partidas <span aria-hidden="true">›</span>';
      button.disabled = !(performanceStreaks[type] || []).length;
    }
    if (container) container.hidden = !open;
    if (open) renderStreakMatches(type);
  });
}

function toggleStreakMatches(type) {
  if (!['wins', 'unbeaten'].includes(type) || !(performanceStreaks[type] || []).length) return;
  expandedStreak = expandedStreak === type ? null : type;
  syncStreakExpansion();
}

let recentPerformanceMatches = [];
let expandedRecentForm = false;

function renderRecentFormMatches() {
 const container=document.getElementById('recent-form-matches');
 if(!container)return;
 const matches=recentPerformanceMatches;
 if(!matches.length){container.textContent='Nenhuma partida para exibir.';return;}
 const ordered=matches;
 container.innerHTML=sharedDetailsHeader()+ordered.map(m=>sharedDetailsRow(sharedMatchDate(m),m.adv,m.placar,m.torneio,getMatchResult(m))).join('');
}

function syncRecentFormExpansion() {
  const button = document.querySelector('[data-action="toggle-recent-form-matches"]');
  const container = document.getElementById('recent-form-matches');
  if (button) {
    button.disabled = !recentPerformanceMatches.length;
    button.setAttribute('aria-expanded', String(expandedRecentForm));
    button.innerHTML = expandedRecentForm ? 'Ocultar partidas <span aria-hidden="true">⌃</span>' : 'Ver partidas <span aria-hidden="true">›</span>';
  }
  if (container) container.hidden = !expandedRecentForm;
  if (expandedRecentForm) renderRecentFormMatches();
}

function toggleRecentFormMatches() {
  if (!recentPerformanceMatches.length) return;
  expandedRecentForm = !expandedRecentForm;
  syncRecentFormExpansion();
}

function updatePerformanceInsights() {
  const scored = filteredMatches.filter(m => getMatchResult(m));
  const recent = scored.slice().sort((a, b) => (b.timestamp || computeTimestamp(b.data)) - (a.timestamp || computeTimestamp(a.data))).slice(0, 5).reverse();
  recentPerformanceMatches = recent;
  if (expandedRecentForm && !recent.length) expandedRecentForm = false;
  const recentResults = document.getElementById('recent-form-results');
  if (recentResults) {
    recentResults.innerHTML = recent.length ? recent.map(m => {
      const r = getMatchResult(m);
      return `<span class="recent-result recent-result-${r.toLowerCase()}" title="${escapeHtml(m.data)} · ${escapeHtml(m.adv)} · ${escapeHtml(m.placar)}">${r}</span>`;
    }).join('') : '<span class="text-xs text-white/40">Sem jogos com placar no recorte.</span>';
  }
  const wins = recent.filter(m => getMatchResult(m) === 'V').length;
  const draws = recent.filter(m => getMatchResult(m) === 'E').length;
  const points = wins * 3 + draws;
  const possible = recent.length * 3;
  const gf = recent.reduce((sum, m) => sum + (Number.isFinite(m.gf) ? m.gf : 0), 0);
  const ga = recent.reduce((sum, m) => sum + (Number.isFinite(m.ga) ? m.ga : 0), 0);
  const rateEl = document.getElementById('recent-form-rate');
  const gfEl = document.getElementById('recent-form-gf');
  const gaEl = document.getElementById('recent-form-ga');
  if (rateEl) {
    const rate = possible ? Math.round((points / possible) * 100) : null;
    rateEl.textContent = rate !== null ? `${rate}%` : '-';
    rateEl.style.color = rate !== null ? recentRateColor(rate) : '';
  }
  if (gfEl) gfEl.textContent = recent.length ? gf.toLocaleString('pt-BR') : '-';
  if (gaEl) gaEl.textContent = recent.length ? ga.toLocaleString('pt-BR') : '-';

  const winStreak = calculateLongestStreak(filteredMatches, r => r === 'V');
  const unbeatenStreak = calculateLongestStreak(filteredMatches, r => r === 'V' || r === 'E');
  const winCount = document.getElementById('streak-wins-count');
  const winPeriod = document.getElementById('streak-wins-period');
  const unbeatenCount = document.getElementById('streak-unbeaten-count');
  const unbeatenPeriod = document.getElementById('streak-unbeaten-period');
  const unbeatenBreakdown = document.getElementById('streak-unbeaten-breakdown');
  performanceStreaks = { wins: winStreak, unbeaten: unbeatenStreak };
  if (expandedStreak && !performanceStreaks[expandedStreak].length) expandedStreak = null;
  if (winCount) winCount.textContent = winStreak.length || '0';
  if (winPeriod) winPeriod.textContent = winStreak.length ? formatMatchPeriod(winStreak[0], winStreak[winStreak.length - 1]) : 'Nenhuma vitória no recorte';
  if (unbeatenCount) unbeatenCount.textContent = unbeatenStreak.length || '0';
  if (unbeatenStreak.length) {
    const v = unbeatenStreak.filter(m => getMatchResult(m) === 'V').length;
    const e = unbeatenStreak.length - v;
    if (unbeatenPeriod) unbeatenPeriod.textContent = formatMatchPeriod(unbeatenStreak[0], unbeatenStreak[unbeatenStreak.length - 1]);
    if (unbeatenBreakdown) unbeatenBreakdown.textContent = `(${v}V / ${e}E)`;
  } else {
    if (unbeatenPeriod) unbeatenPeriod.textContent = 'Nenhuma sequência no recorte';
    if (unbeatenBreakdown) unbeatenBreakdown.textContent = '';
  }
  syncStreakExpansion();
  syncRecentFormExpansion();
}

function updateKpis() {
  const validFiltered = filteredMatches;

  document.getElementById("filtered-matches-tag").textContent = `${validFiltered.length} de ${MATCHES_DATA.length} partidas`;
  document.getElementById("kpi-jogos").textContent = validFiltered.length;
  document.getElementById("summary-total-games").textContent = `${MATCHES_DATA.length} Jogos`;

  let sumPub = 0, countPub = 0;
  let sumHome = 0, countHome = 0;
  let sumVis = 0, countVis = 0;
  let sumSul = 0, countSul = 0;
  let missingSulCount = 0;
  const missingSulByTournament = new Map();

  let vitorias = 0, empates = 0, derrotas = 0, gpTotal = 0, gcTotal = 0;
  const advStatsEstadio = {}; 

  validFiltered.forEach(m => {
    if (m.pub !== null && m.pub > 0) {
      sumPub += m.pub;
      countPub++;
      if (m.mando === "Mandante") {
        sumHome += m.pub;
        countHome++;
      }
    }
    if (m.pubVis !== null && m.pubVis > 0) {
      sumVis += m.pubVis;
      countVis++;
    }
    if (m.estadio === "Maracanã") {
      if (m.sul !== null && m.sul > 0) {
        sumSul += m.sul;
        countSul++;
      } else {
        missingSulCount++;
        const tournament = (m.torneio && m.torneio !== "-") ? m.torneio : "Sem torneio informado";
        missingSulByTournament.set(tournament, (missingSulByTournament.get(tournament) || 0) + 1);
      }
    }

    if (m.gf !== null && m.ga !== null) {
      const fluGols = m.gf, advGols = m.ga;
      gpTotal += fluGols;
      gcTotal += advGols;
      
      let res = 'E';
      if (fluGols > advGols) { vitorias++; res = 'V'; }
      else if (fluGols < advGols) { derrotas++; res = 'D'; }
      else { empates++; res = 'E'; }

      if (!advStatsEstadio[m.adv]) advStatsEstadio[m.adv] = { jog: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0 };
      const st = advStatsEstadio[m.adv];
      st.jog++; st.gp += fluGols; st.gc += advGols;
      if (res === 'V') st.v++; else if (res === 'E') st.e++; else st.d++;
    }
  });

  const avgGeral = countPub ? sumPub / countPub : 0;
  document.getElementById("kpi-media-geral").textContent = avgGeral > 0 ? fmt(avgGeral) : "-";
  document.getElementById("kpi-sub-geral").textContent = countPub > 0 ? `${countPub} jogos com público registrado` : "Nenhum público registrado";

  const avgHome = countHome ? sumHome / countHome : 0;
  document.getElementById("kpi-media-mandante").textContent = countHome > 0 ? fmt(avgHome) : "-";
  document.getElementById("kpi-sub-mandante").textContent = countHome > 0 ? `${countHome} jogos com mando do Fluminense` : "Nenhum jogo mandante";

  const avgVisit = countVis ? sumVis / countVis : 0;
  document.getElementById("kpi-media-visitante").textContent = countVis > 0 ? fmt(avgVisit) : "-";
  document.getElementById("kpi-sub-visitante").textContent = countVis > 0 ? `${countVis} jogos com Tricolores visitantes` : "Sem público visitante";

  const avgSul = countSul ? sumSul / countSul : 0;
  document.getElementById("kpi-media-sul").textContent = countSul > 0 ? fmt(avgSul) : "-";
  document.getElementById("kpi-sub-sul").textContent = countSul > 0 ? `${countSul} jogos com Tricolores no Setor Sul` : "Sem dados do Setor Sul";

  const taxaSul = avgSul > 0 ? (avgSul / CONFIG.capacidadeSulPagantes) * 100 : 0;
  document.getElementById("kpi-taxa-sul").textContent = taxaSul > 0 ? `${taxaSul.toFixed(1)}%` : "-";
  document.getElementById("sul-recorded-count").textContent = `${countSul} jogos`;

  const alertEl = document.getElementById("sul-alert-missing");
  const summaryEl = document.getElementById("sul-missing-summary");
  if (alertEl && summaryEl) {
    if (missingSulCount > 0) {
      const shortTournamentName = (tournament) => {
        const normalized = normalizeComparable(tournament);
        if (normalized === "libertadores da america" || normalized === "conmebol libertadores") return "Libertadores";
        if (normalized === "copa sul-americana" || normalized === "copa sul americana" || normalized === "conmebol sul-americana" || normalized === "conmebol sul americana") return "Sul-Americana";
        return tournament;
      };
      const tournamentSummary = [...missingSulByTournament.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
        .map(([tournament, count]) => `${shortTournamentName(tournament)} (${count})`)
        .join(" · ");
      summaryEl.textContent = `Sem dados oficiais do Setor Sul em ${missingSulCount} ${missingSulCount === 1 ? "jogo" : "jogos"}${tournamentSummary ? `: ${tournamentSummary}` : ""}`;
      alertEl.classList.remove("hidden");
    } else {
      alertEl.classList.add("hidden");
    }
  }

  const totalJogosPerf = validFiltered.length;
  const ptsPossiveis = totalJogosPerf * 3;
  const ptsGanhos = (vitorias * 3) + empates;
  const aproveitamento = ptsPossiveis > 0 ? ((ptsGanhos / ptsPossiveis) * 100).toFixed(1) + '%' : '0%';

  const elEstadioVitorias = document.getElementById('estadio-kpi-vitorias');
  if (elEstadioVitorias) {
    elEstadioVitorias.textContent = vitorias;
    document.getElementById('estadio-sub-vitorias').textContent = totalJogosPerf > 0 ? `${((vitorias/totalJogosPerf)*100).toFixed(1)}% dos jogos` : '0%';
    document.getElementById('estadio-kpi-empates').textContent = empates;
    document.getElementById('estadio-sub-empates').textContent = totalJogosPerf > 0 ? `${((empates/totalJogosPerf)*100).toFixed(1)}% dos jogos` : '0%';
    document.getElementById('estadio-kpi-derrotas').textContent = derrotas;
    document.getElementById('estadio-sub-derrotas').textContent = totalJogosPerf > 0 ? `${((derrotas/totalJogosPerf)*100).toFixed(1)}% dos jogos` : '0%';
    document.getElementById('estadio-kpi-gp').textContent = gpTotal.toLocaleString('pt-BR');
    document.getElementById('estadio-sub-gp').textContent = totalJogosPerf > 0 ? `Média ${(gpTotal/totalJogosPerf).toFixed(2)} por jogo` : '0';
    document.getElementById('estadio-kpi-gc').textContent = gcTotal.toLocaleString('pt-BR');
    document.getElementById('estadio-sub-gc').textContent = totalJogosPerf > 0 ? `Média ${(gcTotal/totalJogosPerf).toFixed(2)} por jogo` : '0';
    document.getElementById('estadio-kpi-aproveitamento').textContent = aproveitamento;
    document.getElementById('estadio-sub-aproveitamento').textContent = `${ptsGanhos} de ${ptsPossiveis} pts`;
  }
  
  updatePerformanceInsights();
  renderAdvTable('estadio-adv-table-body', advStatsEstadio);
}

function getChartCanvas(id) {
  if (activeCharts[id]) activeCharts[id].destroy();
  return document.getElementById(id).getContext('2d');
}

function renderSulBarChart(canvasId, sulMatchesList) {
  if (activeCharts[canvasId]) activeCharts[canvasId].destroy();
  const canvasEl = document.getElementById(canvasId);
  if (!canvasEl) return;

  const ctxSul = canvasEl.getContext('2d');
  if (sulMatchesList.length === 0 && canvasId === "chartClassicosSetorSul") {
    ctxSul.clearRect(0, 0, canvasEl.width, canvasEl.height);
    return;
  }

  const degradeTricolor = ctxSul.createLinearGradient(0, 0, 0, 280);
  degradeTricolor.addColorStop(0, '#0E4735');     
  degradeTricolor.addColorStop(0.35, '#0E4735');  
  degradeTricolor.addColorStop(0.60, '#8A1538');  
  degradeTricolor.addColorStop(1, '#8A1538'); 

  const canvasLegenda = document.createElement('canvas');
  canvasLegenda.width = 60; 
  canvasLegenda.height = 14; 
  const ctxLeg = canvasLegenda.getContext('2d');
  const gradLeg = ctxLeg.createLinearGradient(0, 0, 60, 0);
  gradLeg.addColorStop(0, '#8A1538');     
  gradLeg.addColorStop(0.35, '#8A1538');  
  gradLeg.addColorStop(0.60, '#0E4735');  
  gradLeg.addColorStop(1, '#0E4735');     
  ctxLeg.fillStyle = gradLeg;
  ctxLeg.fillRect(0, 0, 60, 14);

  const padraoLegenda = ctxSul.createPattern(canvasLegenda, 'repeat');
  const sulMobile = window.matchMedia('(max-width: 639px)').matches;

  // V3.2.14: altera apenas Top 5/Top 10 sem reescrever o restante do subtítulo.
  // Assim, o intervalo dinâmico de anos continua sendo atualizado por updateDynamicYearRange().
  const sulSubtitleId = canvasId === 'chartClassicosSetorSul' ? 'classicos-sul-chart-subtitle' : 'sul-chart-subtitle';
  const sulSubtitleEl = document.getElementById(sulSubtitleId);
  const sulTopCountEl = sulSubtitleEl?.querySelector('.sul-top-count');
  if (sulTopCountEl) sulTopCountEl.textContent = sulMobile ? 'Top 5' : 'Top 10';

  // Mobile exibe Top 5; desktop preserva o Top 10 recebido pela função.
  const sulMatchesExibidos = sulMobile ? sulMatchesList.slice(0, 5) : sulMatchesList;

  // V3.1.2: no mobile, desenha sigla (10px) e data (8px) separadamente.
  // O Chart.js aplica uma única fonte a todas as linhas de um tick; este plugin
  // permite reduzir apenas a data sem afetar a versão desktop.
  const sulMobileAxisLabels = {
    id: `sulMobileAxisLabels-${canvasId}`,
    afterDraw(chart) {
      if (!sulMobile) return;
      const xScale = chart.scales.x;
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#526b5b' : '#A3B8B0';

      chart.data.labels.forEach((label, index) => {
        const lines = Array.isArray(label) ? label : [String(label), ''];
        const x = xScale.getPixelForTick(index);
        const y = xScale.bottom + 8;
        ctx.font = "10px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(lines[0] || '', x, y);
        ctx.font = "8px 'Plus Jakarta Sans', sans-serif";
        ctx.fillText(lines[1] || '', x, y + 13);
      });
      ctx.restore();
    }
  };

  // Exibe o público completo dentro da barra, próximo ao ponto mais alto.
  const sulBarValueLabels = {
    id: `sulBarValueLabels-${canvasId}`,
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || meta.hidden) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `700 ${sulMobile ? 10 : 11}px 'Plus Jakarta Sans', sans-serif`;

      meta.data.forEach((bar, index) => {
        const value = Number(chart.data.datasets[0].data[index]);
        if (!Number.isFinite(value)) return;
        ctx.fillText(value.toLocaleString('pt-BR'), bar.x, bar.y + 7);
      });
      ctx.restore();
    }
  };

  activeCharts[canvasId] = new Chart(ctxSul, {
    type: 'bar',
    data: {
      labels: sulMatchesExibidos.map(m => {
        const mobile = window.matchMedia('(max-width: 639px)').matches;
        if (!m.data || m.data === "-") {
          return mobile ? [String(m.adv || '').slice(0, 3).toUpperCase(), '-'] : [`${m.adv}`, `(-)`];
        }
        const p = m.data.split(/[-/]/);
        const dia = p[0].length === 4 ? p[2] : p[0];
        const mes = p[1];
        const ano = p[0].length === 4 ? p[0].slice(2, 4) : p[2].slice(2, 4);
        if (mobile) {
          const anoCompleto = p[0].length === 4 ? p[0] : p[2];
          return [String(m.adv || '').slice(0, 3).toUpperCase(), `${dia}/${mes}/${anoCompleto}`];
        }
        return [`${m.adv}`, `(${dia}-${mes}-${ano})`];
      }),
      datasets: [
        { label: 'Sul Pagantes', data: sulMatchesExibidos.map(m => m.sul), backgroundColor: degradeTricolor, borderRadius: 6, order: 2 },
        { label: 'Capacidade Máxima Pagantes (20K)', data: sulMatchesExibidos.map(() => CONFIG.capacidadeSulPagantes), type: 'line', borderColor: '#f59e0b', borderDash: [5, 5], borderWidth: 3, pointRadius: 0, pointHoverRadius: 0, fill: false, order: 1 }
      ]
    },
    plugins: [sulMobileAxisLabels, sulBarValueLabels],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: sulMobile ? 0 : 0, right: 0, bottom: sulMobile ? 30 : 0 } },
      plugins: { 
        legend: { 
          position: 'top', 
          labels: { 
            color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)'),
            generateLabels: function(chart) {
              const originais = Chart.defaults.plugins.legend.labels.generateLabels(chart);
              originais.forEach(label => {
                if (label.text === 'Sul Pagantes') label.fillStyle = padraoLegenda;
              });
              return originais;
            }
          } 
        }, 
        tooltip: { 
          callbacks: { 
            ...(window.matchMedia('(max-width: 639px)').matches ? {
              title: function(context) {
                const index = context[0].dataIndex;
                const match = sulMatchesExibidos[index];
                if (!match.data || match.data === '-') return match.adv;
                const p = match.data.split(/[-/]/);
                const dia = p[0].length === 4 ? p[2] : p[0];
                const mes = p[1];
                const ano = p[0].length === 4 ? p[0] : p[2];
                return `${match.adv} • ${dia}/${mes}/${ano}`;
              }
            } : {}),
            afterTitle: function(context) {
              const index = context[0].dataIndex;
              return sulMatchesExibidos[index].torneio;
            },
            label: ctx => ctx.dataset.type === 'line' ? `Capacidade Máxima Pagantes (20K)` : ` Sul Pagantes: ${ctx.parsed.y.toLocaleString('pt-BR')} (${((ctx.parsed.y / CONFIG.capacidadeSulPagantes) * 100).toFixed(1)}% do setor)` 
          } 
        }
      }, 
      scales: {
        x: {
          offset: true,
          grid: { display: false },
          ticks: {
            color: '#A3B8B0',
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0,
            padding: sulMobile ? 0 : 8,
            display: !sulMobile,
            font: { size: 12, lineHeight: 1.25 }
          }
        },
        y: { beginAtZero: true, max: 22000, ticks: { display: !sulMobile, callback: v => v === 22000 ? '' : v.toLocaleString('pt-BR') } }
      } 
    }
  });
}

function updateCharts() {
  const validFiltered = filteredMatches;
  const chartsMobile = window.matchMedia('(max-width: 767px)').matches;
  const lightChart = document.documentElement.dataset.theme === 'light';
  Chart.defaults.color = lightChart ? '#526b5b' : '#A3B8B0';
  Chart.defaults.borderColor = lightChart ? 'rgba(35,90,58,.14)' : 'rgba(255, 255, 255, 0.07)';
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

  const mCount = selectedState.mando.length;
  const hasM = mCount === 0 || selectedState.mando.includes('Mandante');
  const hasV = mCount === 0 || selectedState.mando.includes('Visitante');
  const hasN = mCount === 0 || selectedState.mando.includes('Neutro');

  let chartMode = 'duplo';
  let titleSuffix = '(Mandante e Visitante)';

  if (mCount > 0) {
    if (hasM && !hasV && !hasN) { chartMode = 'mandante'; titleSuffix = '(Mandante)'; }
    else if (!hasM && hasV && !hasN) { chartMode = 'visitante'; titleSuffix = '(Visitante)'; }
    else if (!hasM && !hasV && hasN) { chartMode = 'neutro'; titleSuffix = '(Campo Neutro)'; }
    else if (hasM && hasN && !hasV) { chartMode = 'mandante'; titleSuffix = '(Mandante)'; }
    else if (!hasM && hasV && hasN) { chartMode = 'visitante'; titleSuffix = '(Visitante)'; }
    else { chartMode = 'duplo'; titleSuffix = '(Mandante e Visitante)'; }
  }

  const titleTemporada = document.getElementById('title-temporada');
  if(titleTemporada) titleTemporada.textContent = `Público Médio por Temporada ${titleSuffix}`;
  const titleCompeticao = document.getElementById('title-competicao');
  if(titleCompeticao) titleCompeticao.textContent = `Público Médio por Competição ${titleSuffix}`;
  const titleDia = document.getElementById('title-dia');
  if(titleDia) titleDia.textContent = `Média de Público por Dia da Semana ${titleSuffix}`;
  const titleHorario = document.getElementById('title-horario');
  if(titleHorario) titleHorario.textContent = `Média de Público por Faixa de Horário ${titleSuffix}`;

  const showLegend = chartMode === 'duplo';

  // Varredura única O(N) para agregar todas as dimensões dos gráficos
  const byYear = {};
  const byComp = {};
  const byDay = {};
  const daysOrder = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'];
  daysOrder.forEach(d => { byDay[d] = { sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 }; });

  const hourRanges = [
    { label: "Manhã (<13h)", min: 0, max: 12, sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 },
    { label: "Tarde (13h-17h59)", min: 13, max: 17, sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 },
    { label: "Noite (18h-20h59)", min: 18, max: 20, sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 },
    { label: "Noite Tardia (≥21h)", min: 21, max: 24, sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 }
  ];

  const visitEstadioMap = {};
  const mandantePublicos = [];
  const sulCandidates = [];

  validFiltered.forEach(m => {
    // Inicializa Ano
    if (!byYear[m.ano]) byYear[m.ano] = { sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0, v: 0, e: 0, d: 0 };
    const yrObj = byYear[m.ano];

    // Desempenho por temporada
    if (m.gf !== null && m.ga !== null) {
      if (m.gf > m.ga) yrObj.v++;
      else if (m.gf < m.ga) yrObj.d++;
      else yrObj.e++;
    }

    // Inicializa Competição
    let compObj = null;
    if (m.torneio && m.torneio !== "-") {
      if (!byComp[m.torneio]) byComp[m.torneio] = { sM: 0, cM: 0, sV: 0, cV: 0, sN: 0, cN: 0 };
      compObj = byComp[m.torneio];
    }

    // Dia da Semana
    const dayObj = byDay[m.dia] || null;

    // Faixa de Horário
    let hrObj = null;
    if (m.hNum !== null) {
      for (let i = 0; i < hourRanges.length; i++) {
        if (m.hNum >= hourRanges[i].min && m.hNum <= hourRanges[i].max) {
          hrObj = hourRanges[i];
          break;
        }
      }
    }

    // Acumula públicos conforme Mando
    if (m.mando === 'Mandante' && m.pub > 0) {
      mandantePublicos.push(m.pub);
      yrObj.sM += m.pub; yrObj.cM++;
      if (compObj) { compObj.sM += m.pub; compObj.cM++; }
      if (dayObj) { dayObj.sM += m.pub; dayObj.cM++; }
      if (hrObj) { hrObj.sM += m.pub; hrObj.cM++; }
    } else if (m.mando === 'Visitante' && m.pubVis > 0) {
      yrObj.sV += m.pubVis; yrObj.cV++;
      if (compObj) { compObj.sV += m.pubVis; compObj.cV++; }
      if (dayObj) { dayObj.sV += m.pubVis; dayObj.cV++; }
      if (hrObj) { hrObj.sV += m.pubVis; hrObj.cV++; }
    } else if (m.mando === 'Neutro' && m.pub > 0) {
      yrObj.sN += m.pub; yrObj.cN++;
      if (compObj) { compObj.sN += m.pub; compObj.cN++; }
      if (dayObj) { dayObj.sN += m.pub; dayObj.cN++; }
      if (hrObj) { hrObj.sN += m.pub; hrObj.cN++; }
    }

    // Top 10 Visitante (todos os jogos com pubVis > 0)
    if (m.pubVis !== null && m.pubVis > 0) {
      if (!visitEstadioMap[m.estadio]) visitEstadioMap[m.estadio] = { sum: 0, count: 0 };
      visitEstadioMap[m.estadio].sum += m.pubVis;
      visitEstadioMap[m.estadio].count += 1;
    }

    // Setor Sul Maracanã
    if (m.estadio === "Maracanã" && m.sul !== null && m.sul > 0) {
      sulCandidates.push(m);
    }
  });

  // 1. TEMPORADA
  const seasons = Object.keys(byYear).map(Number).sort((a,b) => a - b);
  const dsMand = [], countMand = [], dsVis = [], countVis = [], dsNeu = [], countNeu = [];
  const vTemporada = [], eTemporada = [], dTemporada = [];

  seasons.forEach(yr => {
    const y = byYear[yr];
    dsMand.push(y.cM ? Math.round(y.sM / y.cM) : 0); countMand.push(y.cM);
    dsVis.push(y.cV ? Math.round(y.sV / y.cV) : 0); countVis.push(y.cV);
    dsNeu.push(y.cN ? Math.round(y.sN / y.cN) : 0); countNeu.push(y.cN);
    vTemporada.push(y.v); eTemporada.push(y.e); dTemporada.push(y.d);
  });

  let datasetsTemp = [];
  if (chartMode === 'mandante') datasetsTemp = [{ label: 'Mandante', data: dsMand, backgroundColor: '#0E4735', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: countMand }];
  else if (chartMode === 'visitante') datasetsTemp = [{ label: 'Visitante', data: dsVis, backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: countVis }];
  else if (chartMode === 'neutro') datasetsTemp = [{ label: 'Média Neutro', data: dsNeu, backgroundColor: '#0f766e', borderColor: '#06b6d4', borderWidth: 1.5, borderRadius: 6, customCount: countNeu }];
  else {
    datasetsTemp = [
      { label: 'Mandante', data: dsMand, backgroundColor: '#0E4735', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: countMand },
      { label: 'Visitante', data: dsVis, backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: countVis }
    ];
  }
  activeCharts["chartTemporada"] = new Chart(getChartCanvas("chartTemporada"), {
    type: 'bar', data: { labels: seasons.map(String), datasets: datasetsTemp },
    plugins: [makeValueLabelsPlugin('publicoMedioTemporadaLabels', { decimals: 1, fullWhenSingleVisible: true })],
    options: { layout: { padding: { top: 18 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: showLegend, position: 'top', labels: {color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)')} }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { y: { beginAtZero: true, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } } } }
  });

  // 2. COMPETICAO
  const compStats = Object.keys(byComp).map(c => {
    const o = byComp[c];
    return {
      comp: c,
      mM: o.cM ? Math.round(o.sM / o.cM) : 0, cM: o.cM,
      mV: o.cV ? Math.round(o.sV / o.cV) : 0, cV: o.cV,
      mN: o.cN ? Math.round(o.sN / o.cN) : 0, cN: o.cN
    };
  });
  let filteredCompStats = [];
  if (chartMode === 'mandante') filteredCompStats = compStats.filter(s => s.cM > 0).sort((a,b) => b.mM - a.mM);
  else if (chartMode === 'visitante') filteredCompStats = compStats.filter(s => s.cV > 0).sort((a,b) => b.mV - a.mV);
  else if (chartMode === 'neutro') filteredCompStats = compStats.filter(s => s.cN > 0).sort((a,b) => b.mN - a.mN);
  else filteredCompStats = compStats.filter(s => s.cM > 0 || s.cV > 0).sort((a,b) => Math.max(b.mM, b.mV) - Math.max(a.mM, a.mV));

  let datasetsComp = [];
  if (chartMode === 'mandante') datasetsComp = [{ label: 'Mandante', data: filteredCompStats.map(s=>s.mM), backgroundColor: '#0E4735', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: filteredCompStats.map(s=>s.cM) }];
  else if (chartMode === 'visitante') datasetsComp = [{ label: 'Visitante', data: filteredCompStats.map(s=>s.mV), backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: filteredCompStats.map(s=>s.cV) }];
  else if (chartMode === 'neutro') datasetsComp = [{ label: 'Média Neutro', data: filteredCompStats.map(s=>s.mN), backgroundColor: '#0f766e', borderColor: '#06b6d4', borderWidth: 1.5, borderRadius: 6, customCount: filteredCompStats.map(s=>s.cN) }];
  else {
    datasetsComp = [
      { label: 'Mandante', data: filteredCompStats.map(s=>s.mM), backgroundColor: '#0E4735', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: filteredCompStats.map(s=>s.cM) },
      { label: 'Visitante', data: filteredCompStats.map(s=>s.mV), backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: filteredCompStats.map(s=>s.cV) }
    ];
  }
  activeCharts["chartCompeticao"] = new Chart(getChartCanvas("chartCompeticao"), {
    type: 'bar',
    data: { labels: filteredCompStats.map(s => s.comp), datasets: datasetsComp },
    plugins: [makeValueLabelsPlugin('publicoMedioCompeticaoLabels', { horizontal: true, fullValue: true })],
    options: {
      indexAxis: 'y',
      layout: { padding: { left: 0, right: chartsMobile ? 44 : 58 } },
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: showLegend, position: 'top', labels: { color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)') } },
        tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.x.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } }
      },
      scales: {
        x: { display: !chartsMobile, beginAtZero: true, grace: chartsMobile ? '4%' : 0, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } },
        y: { ticks: { display: true, padding: chartsMobile ? 2 : 6, font: { size: chartsMobile ? 10 : 12 } }, afterFit: scale => { if (chartsMobile) scale.width = Math.min(150, Math.max(scale.width, 132)); } }
      }
    }
  });

  // 3. DIA DA SEMANA
  const dsMandDia = [], countMandDia = [], dsVisDia = [], countVisDia = [], dsNeuDia = [], countNeuDia = [];
  daysOrder.forEach(d => {
    const o = byDay[d];
    dsMandDia.push(o.cM ? Math.round(o.sM / o.cM) : 0); countMandDia.push(o.cM);
    dsVisDia.push(o.cV ? Math.round(o.sV / o.cV) : 0); countVisDia.push(o.cV);
    dsNeuDia.push(o.cN ? Math.round(o.sN / o.cN) : 0); countNeuDia.push(o.cN);
  });
  const bgMandante = daysOrder.map(d => ['Sábado', 'Domingo'].includes(d) ? '#C5A059' : '#0E4735');
  const bgVisitante = daysOrder.map(d => ['Sábado', 'Domingo'].includes(d) ? '#e11d48' : '#8A1538');
  const bgNeutro = daysOrder.map(d => ['Sábado', 'Domingo'].includes(d) ? '#06b6d4' : '#0f766e');
  let datasetsDia = [];
  if (chartMode === 'mandante') datasetsDia = [{ label: 'Mandante', data: dsMandDia, backgroundColor: bgMandante, borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 8, customCount: countMandDia }];
  else if (chartMode === 'visitante') datasetsDia = [{ label: 'Visitante', data: dsVisDia, backgroundColor: bgVisitante, borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 8, customCount: countVisDia }];
  else if (chartMode === 'neutro') datasetsDia = [{ label: 'Média Neutro', data: dsNeuDia, backgroundColor: bgNeutro, borderColor: '#06b6d4', borderWidth: 1.5, borderRadius: 8, customCount: countNeuDia }];
  else {
    const bwDuplo = daysOrder.map(d => ['Sábado', 'Domingo'].includes(d) ? 2.5 : 1.5);
    datasetsDia = [
      { label: 'Mandante', data: dsMandDia, backgroundColor: '#0E4735', borderColor: '#C5A059', borderWidth: bwDuplo, borderRadius: 6, customCount: countMandDia },
      { label: 'Visitante', data: dsVisDia, backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: bwDuplo, borderRadius: 6, customCount: countVisDia }
    ];
  }
  activeCharts["chartDiaSemana"] = new Chart(getChartCanvas("chartDiaSemana"), {
    type: 'bar', data: { labels: chartsMobile ? ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB', 'DOM'] : daysOrder.map(d => d.replace('-feira', '')), datasets: datasetsDia },
    plugins: [makeValueLabelsPlugin('publicoMedioDiaLabels', { decimals: 1, fullWhenSingleVisible: true })],
    options: { layout: { padding: { top: 18, left: chartsMobile ? 0 : 6, right: chartsMobile ? 2 : 6 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: showLegend, position: 'top', labels: {color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)')} }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { y: { display: !chartsMobile, beginAtZero: true, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } } } }
  });

  // 4. HORARIO
  const dsMandHor = [], countMandHor = [], dsVisHor = [], countVisHor = [], dsNeuHor = [], countNeuHor = [];
  hourRanges.forEach(hr => {
    dsMandHor.push(hr.cM ? Math.round(hr.sM / hr.cM) : 0); countMandHor.push(hr.cM);
    dsVisHor.push(hr.cV ? Math.round(hr.sV / hr.cV) : 0); countVisHor.push(hr.cV);
    dsNeuHor.push(hr.cN ? Math.round(hr.sN / hr.cN) : 0); countNeuHor.push(hr.cN);
  });
  let datasetsHor = [];
  if (chartMode === 'mandante') datasetsHor = [{ label: 'Mandante', data: dsMandHor, borderColor: '#C5A059', backgroundColor: 'rgba(14, 71, 53, 0.25)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#8A1538', pointBorderColor: '#FFF', pointRadius: 6, customCount: countMandHor }];
  else if (chartMode === 'visitante') datasetsHor = [{ label: 'Visitante', data: dsVisHor, borderColor: '#e11d48', backgroundColor: 'rgba(138, 21, 56, 0.25)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#C5A059', pointBorderColor: '#FFF', pointRadius: 6, customCount: countVisHor }];
  else if (chartMode === 'neutro') datasetsHor = [{ label: 'Média Neutro', data: dsNeuHor, borderColor: '#06b6d4', backgroundColor: 'rgba(15, 118, 110, 0.25)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#0f766e', pointBorderColor: '#FFF', pointRadius: 6, customCount: countNeuHor }];
  else {
    datasetsHor = [
      { label: 'Mandante', data: dsMandHor, borderColor: '#0E4735', backgroundColor: 'rgba(14, 71, 53, 0.15)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#C5A059', pointRadius: 5, customCount: countMandHor },
      { label: 'Visitante', data: dsVisHor, borderColor: '#870A28', backgroundColor: 'rgba(138, 21, 56, 0.15)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#C5A059', pointRadius: 5, customCount: countVisHor }
    ];
  }
  activeCharts["chartHorario"] = new Chart(getChartCanvas("chartHorario"), {
    type: 'line',
    data: { labels: chartsMobile ? [['Manhã', '(<13h)'], ['Tarde', '(13h–17h59)'], ['Noite', '(18h–20h59)'], ['Noite Tardia', '(≥21h)']] : hourRanges.map(h => h.label), datasets: datasetsHor },
    plugins: [makeValueLabelsPlugin('publicoMedioHorarioLabels', { fullValue: true })],
    options: {
      layout: { padding: { top: 18, left: chartsMobile ? 0 : 6, right: chartsMobile ? 2 : 6 } },
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: showLegend, position: 'top', labels: { color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)') } },
        tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } }
      },
      scales: {
        x: { ticks: { maxRotation: 0, minRotation: 0, autoSkip: false, font: { size: chartsMobile ? 9 : 12 } } },
        y: { display: !chartsMobile, beginAtZero: true, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } }
      }
    }
  });

  // 5. TOP VISITANTE
  const topVisitanteSection = document.getElementById("section-top-visitante");
  if (topVisitanteSection) {
    if (hasV) {
      topVisitanteSection.classList.remove("hidden");
      const topEstadios = Object.keys(visitEstadioMap)
        .map(est => ({ est, avg: Math.round(visitEstadioMap[est].sum / visitEstadioMap[est].count), count: visitEstadioMap[est].count }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 10);
      if (activeCharts["chartTopVisitante"]) activeCharts["chartTopVisitante"].destroy();
      if (topEstadios.length > 0) {
        activeCharts["chartTopVisitante"] = new Chart(getChartCanvas("chartTopVisitante"), {
          type: 'bar', data: { labels: topEstadios.map(e => e.est), datasets: [{ label: 'Média de Público', data: topEstadios.map(e => e.avg), backgroundColor: '#870A28', borderColor: '#C5A059', borderWidth: 1.5, borderRadius: 6, customCount: topEstadios.map(e => e.count) }] },
          plugins: [makeValueLabelsPlugin('topVisitanteLabels', { horizontal: true, mobileOutside: true, fullValue: true })],
          options: { indexAxis: 'y', layout: { padding: { right: chartsMobile ? 54 : 60, top: 6, bottom: 4 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` Média: ${ctx.parsed.x.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { x: { display: !chartsMobile, beginAtZero: true, grace: '15%', grid: { display: false }, border: { display: false }, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } }, y: { grid: { display: false }, border: { display: false }, ticks: { display: true, padding: chartsMobile ? 2 : 6 } } } }
        });
      } else {
        const ctx = getChartCanvas("chartTopVisitante"); ctx.font = "12px 'Plus Jakarta Sans', sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.textAlign = "center"; ctx.fillText("Nenhum dado de público visitante para os filtros atuais.", ctx.canvas.width / 2, 50);
      }
    } else {
      topVisitanteSection.classList.add("hidden");
    }
  }

  // 6. DISTRIBUIÇÃO DO PÚBLICO (MANDANTE)
  // Exibe quando Mandante faz parte do filtro Mando. Se houver outras opções
  // selecionadas junto com Mandante, somente os jogos como mandante entram aqui.
  const distribuicaoMandanteSection = document.getElementById('section-distribuicao-mandante');
  if (distribuicaoMandanteSection) {
    if (hasM) {
      distribuicaoMandanteSection.classList.remove('hidden');

      const faixas = [
        { label: '0–10 mil', min: 0, max: 10000 },
        { label: '10–20 mil', min: 10000, max: 20000 },
        { label: '20–30 mil', min: 20000, max: 30000 },
        { label: '30–40 mil', min: 30000, max: 40000 },
        { label: '40–50 mil', min: 40000, max: 50000 },
        { label: '50–60 mil', min: 50000, max: 60000 },
        { label: '60 mil+', min: 60000, max: Infinity }
      ].map(f => ({ ...f, count: 0, sum: 0 }));

      mandantePublicos.forEach(pub => {
        const faixa = faixas.find(f => pub >= f.min && pub < f.max);
        if (faixa) { faixa.count += 1; faixa.sum += pub; }
      });

      const totalMandante = mandantePublicos.length;
      const countLabelsPlugin = {
        id: 'distribuicaoMandanteCountLabels',
        afterDatasetsDraw(chart) {
          const { ctx, chartArea } = chart;
          ctx.save();
          ctx.font = `700 ${window.innerWidth <= 639 ? 11 : 11}px 'Plus Jakarta Sans', sans-serif`;
          ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#244634' : 'rgba(255,255,255,0.88)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const meta = chart.getDatasetMeta(0);
          meta.data.forEach((bar, i) => {
            const value = chart.data.datasets[0].data[i];
            if (!value) return;
            ctx.fillText(String(value), bar.x, Math.max(chartArea.top + 12, bar.y - 6));
          });
          ctx.restore();
        }
      };

      activeCharts['chartDistribuicaoMandante'] = new Chart(getChartCanvas('chartDistribuicaoMandante'), {
        type: 'bar',
        data: {
          labels: faixas.map(f => window.innerWidth <= 639 ? (f.label === '60 mil+' ? ['60', 'mil+'] : [f.label.replace(' mil', ''), 'mil']) : f.label),
          datasets: [{
            label: 'Jogos',
            data: faixas.map(f => f.count),
            backgroundColor: '#0E4735',
            borderColor: '#C5A059',
            borderWidth: 1.5,
            borderRadius: 7,
            customSum: faixas.map(f => f.sum)
          }]
        },
        plugins: [countLabelsPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 18 } },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: items => items.length ? items[0].label : '',
                label: ctx => {
                  const jogos = ctx.parsed.y || 0;
                  const pct = totalMandante > 0 ? ((jogos / totalMandante) * 100).toFixed(1).replace('.', ',') : '0,0';
                  return ` Jogos: ${jogos} (${pct}%)`;
                },
                afterLabel: ctx => {
                  const jogos = ctx.parsed.y || 0;
                  const soma = ctx.dataset.customSum[ctx.dataIndex] || 0;
                  const media = jogos > 0 ? Math.round(soma / jogos) : 0;
                  return ` Público médio: ${media.toLocaleString('pt-BR')}`;
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { maxRotation: 0, minRotation: 0, font: { size: window.innerWidth <= 639 ? 9 : 11 } },
              grid: { display: false }
            },
            y: {
              beginAtZero: true,
              ticks: { display: false, precision: 0 }
            }
          }
        }
      });
    } else {
      distribuicaoMandanteSection.classList.add('hidden');
      if (activeCharts['chartDistribuicaoMandante']) {
        activeCharts['chartDistribuicaoMandante'].destroy();
        delete activeCharts['chartDistribuicaoMandante'];
      }
    }
  }

  // 7. DESEMPENHO POR TEMPORADA
  const desempenhoTemporadaLabelsPlugin = {
    id: 'desempenhoTemporadaLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = "600 12px 'Plus Jakarta Sans', sans-serif";
      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#244634' : 'rgba(255,255,255,0.88)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (meta.hidden) return;

        meta.data.forEach((bar, dataIndex) => {
          const value = dataset.data[dataIndex];
          if (value === null || value === undefined || Number.isNaN(Number(value))) return;
          const y = Math.max(bar.y - 10, chartArea.top + 14);
          ctx.fillText(Number(value).toLocaleString('pt-BR'), bar.x, y);
        });
      });
      ctx.restore();
    }
  };

  activeCharts["chartDesempenhoTemporada"] = new Chart(getChartCanvas("chartDesempenhoTemporada"), {
    type: 'bar',
    data: {
      labels: seasons.map(String),
      datasets: [
        { label: 'Vitórias', data: vTemporada, backgroundColor: '#047857', borderRadius: 4 },
        { label: 'Empates', data: eTemporada, backgroundColor: '#D97706', borderRadius: 4 },
        { label: 'Derrotas', data: dTemporada, backgroundColor: '#BE123C', borderRadius: 4 }
      ]
    },
    plugins: [desempenhoTemporadaLabelsPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: chartsMobile ? 32 : 30 } },
      plugins: { 
        legend: { position: 'top', labels: { color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)') } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { stacked: false, ticks: { color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)') }, grid: { display: false } },
        y: { beginAtZero: true, grace: chartsMobile ? '20%' : '16%', ticks: { display: false, color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)') }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });

  // 7. SETOR SUL
  const sulMatches = sulCandidates.sort((a, b) => b.sul - a.sul).slice(0, 10);
  renderSulBarChart("chartSetorSul", sulMatches);
}

function getMatchResult(match) {
  if (match.gf === null || match.gf === undefined || match.ga === null || match.ga === undefined) return null;
  if (match.gf > match.ga) return 'V';
  if (match.gf < match.ga) return 'D';
  return 'E';
}

function formatCatalogDate(value) {
 const raw=String(value||'').trim();
 const iso=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
 if(iso)return `${iso[3]}/${iso[2]}/${iso[1]}`;
 const br=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 if(br)return `${br[1].padStart(2,'0')}/${br[2].padStart(2,'0')}/${br[3]}`;
 const dt=computeTimestamp(raw);
 if(Number.isFinite(dt)&&dt>0){
  const date=new Date(dt);
  return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}/${date.getFullYear()}`;
 }
 return raw||'-';
}
function resultBadge(match) {
  const result = getMatchResult(match);
  const styles = {
    V: 'result-win bg-emerald-950/90 border-emerald-500/60 text-emerald-300',
    E: 'result-draw',
    D: 'result-loss bg-rose-950/90 border-rose-500/60 text-rose-300'
  };
  if (!result) return `<span class="font-bold text-white">${escapeHtml(match.placar)}</span>`;
  return `<span class="inline-flex items-center gap-2 px-2 py-1 rounded-lg border catalog-score-compact ${styles[result]} font-sans font-bold whitespace-nowrap"><span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-black/25 text-[10px] catalog-score-result">${result}</span><span class="font-mono result-score-text text-white">${escapeHtml(match.placar)}</span></span>`;
}

function compareTableValues(a, b, key) {
  const values = {
    date: m => m.timestamp || computeTimestamp(m.data),
    time: m => String(m.hora || ''),
    competition: m => normalizeComparable(m.torneio),
    homeAway: m => normalizeComparable(m.mando),
    opponent: m => normalizeComparable(m.adv),
    stadium: m => normalizeComparable(m.estadio),
    score: m => ((m.gf ?? -1) * 100) + (m.ga ?? -1),
    attendance: m => m.pub ?? -1,
    visitors: m => m.pubVis ?? -1,
    south: m => m.sul ?? -1,
    southRate: m => m.sul ?? -1,
    presence: m => normalizeComparable(m.presente)
  };
  const getter = values[key] || values.date;
  const av = getter(a), bv = getter(b);
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

function sortedTableData(data, state) {
  return [...data].sort((a, b) => {
    const result = compareTableValues(a, b, state.key);
    return state.direction === 'asc' ? result : -result;
  });
}

function sortIndicator(state, key) {
  if (state.key !== key) return '<span class="table-sort-neutral">↕</span>';
  return `<span class="table-sort-active">${state.direction === 'asc' ? '↑' : '↓'}</span>`;
}

function updateSortIndicators(scope, state) {
  document.querySelectorAll(`[data-sort-scope="${scope}"]`).forEach(button => {
    const indicator = button.querySelector('.sort-indicator');
    if (indicator) indicator.innerHTML = sortIndicator(state, button.dataset.sortKey);
    button.setAttribute('aria-sort', state.key === button.dataset.sortKey ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function sortCatalog(scope, key) {
  const state = scope === 'classicos' ? classicosTableSort : mainTableSort;
  if (state.key === key) state.direction = state.direction === 'asc' ? 'desc' : 'asc';
  else {
    state.key = key;
    state.direction = ['date', 'attendance', 'visitors', 'south', 'southRate'].includes(key) ? 'desc' : 'asc';
  }
  if (scope === 'classicos') renderClassicosTable(currentFilteredClassicos);
  else {
    tableCurrentPage = 1;
    renderTable();
  }
}

function mainFilterSummary() {
  const labels = {
    temporada: 'Temporada', competicao: 'Competição', mando: 'Mando', adversario: 'Adversário',
    estadio: 'Estádio', dia: 'Dia', horario: 'Horário', presente: 'Presença'
  };
  const items = [];
  Object.entries(selectedState).forEach(([key, values]) => {
    if (values.length) items.push(`${labels[key] || key}: ${values.join(', ')}`);
  });
  if (semRivaisAtivo) items.push('Sem Rivais');
  const search = normalizeText(document.getElementById('search-adversario')?.value || '');
  if (search) items.push(`Busca: “${search}”`);
  return items;
}

function classicosFilterSummary() {
  const items = [];
  if (classicosState.competicao.length) items.push(`Competição: ${classicosState.competicao.join(', ')}`);
  if (classicosState.adversario.length) items.push(`Adversário: ${classicosState.adversario.join(', ')}`);
  if (classicosState.presente.length) items.push(`Presença: ${classicosState.presente.join(', ')}`);
  if (CLASSICOS_DATA.length) {
    const years = CLASSICOS_DATA.map(m => m.ano).filter(Number.isFinite);
    const minAll = Math.min(...years), maxAll = Math.max(...years);
    if (classicosState.minAno > minAll || classicosState.maxAno < maxAll) items.push(`Período: ${classicosState.minAno}-${classicosState.maxAno}`);
  }
  return items;
}

function renderCatalogSummary(scope, count) {
  const isClassicos = scope === 'classicos';
  const container = document.getElementById(isClassicos ? 'classicos-catalog-summary' : 'catalog-summary');
  if (!container) return;
  const items = isClassicos ? classicosFilterSummary() : mainFilterSummary();
  const clearAction = isClassicos ? 'reset-classicos-filters' : 'reset-filters';
  container.innerHTML = `
    <div class="catalog-summary-count"><strong>${count}</strong> ${count === 1 ? 'partida encontrada' : 'partidas encontradas'}</div>
    <div class="catalog-summary-filters">${items.length ? items.map(item => `<span>${escapeHtml(item)}</span>`).join('') : '<span class="catalog-summary-empty">Nenhum filtro restritivo aplicado</span>'}</div>
    ${items.length ? `<button type="button" data-action="${clearAction}" class="catalog-summary-clear">Limpar filtros</button>` : ''}
  `;
}

function renderTable() {
  const validFiltered = sortedTableData(filteredMatches, mainTableSort);
  const tbody = document.getElementById("table-body");
  renderCatalogSummary('main', validFiltered.length);
  updateSortIndicators('main', mainTableSort);
  if (!tbody) return;
  const start = (tableCurrentPage - 1) * tablePageSize;
  const end = start + tablePageSize;
  const pageItems = validFiltered.slice(start, end);

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="p-8 text-center text-white/40 font-sans">Nenhuma partida encontrada para os filtros selecionados.</td></tr>`;
    document.getElementById("table-pagination").innerHTML = "";
    return;
  }

  tbody.innerHTML = pageItems.map(m => {
    const isHome = m.mando === "Mandante";
    const isAway = m.mando === "Visitante";
    const mandoBadge = isHome ? `<span class="catalog-mando-badge catalog-mando-home px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-sans text-[10px] font-bold border border-emerald-500/40">Mandante</span>` : isAway ? `<span class="catalog-mando-badge catalog-mando-away px-2 py-0.5 rounded bg-rose-950 text-rose-300 font-sans text-[10px] font-bold border border-rose-500/40">Visitante</span>` : `<span class="px-2 py-0.5 rounded bg-amber-950 text-amber-300 font-sans text-[10px] font-bold border border-amber-500/40">Neutro</span>`;
    return `<tr class="hover:bg-white/[0.04] transition border-b border-white/5">
      <td class="p-3 text-white/90 whitespace-nowrap">${escapeHtml(formatCatalogDate(m.data))}</td>
      <td class="p-3 font-sans font-bold text-white">${escapeHtml(m.adv)}</td>
      <td class="p-3 text-center">${resultBadge(m)}</td>
      <td class="p-3 font-sans text-[11px] text-white/80" title="${escapeHtml(m.torneio)}">${escapeHtml(m.torneio)}</td>
      <td class="p-3">${mandoBadge}</td>
      <td class="p-3 font-sans text-white/70" title="${escapeHtml(m.estadio)}">${escapeHtml(m.estadio)}</td>
      <td class="p-3 text-right font-bold text-emerald-400">${fmt(m.pub)}</td>
      <td class="p-3 text-right text-rose-300">${fmt(m.pubVis)}</td>
      <td class="p-3 text-right text-cyan-300 font-semibold">${fmt(m.sul)}</td>
    </tr>`;
  }).join('');

  const totalPages = Math.ceil(validFiltered.length / tablePageSize) || 1;
  const pag = document.getElementById("table-pagination");
  pag.innerHTML = `
    <div class="font-sans">Mostrando <strong class="text-white">${start + 1}</strong> a <strong class="text-white">${Math.min(end, validFiltered.length)}</strong> de <strong class="text-white">${validFiltered.length}</strong> partidas</div>
    <div class="flex items-center gap-2 font-sans">
      <button data-action="navigate-page" data-direction="-1" ${tableCurrentPage === 1 ? 'disabled' : ''} class="px-3 py-1.5 bg-white/5 rounded-lg border border-white/10 transition ${tableCurrentPage === 1 ? 'opacity-30 cursor-not-allowed' : 'hover:text-[#C5A059] active:scale-95'}">Anterior</button>
      <span class="px-2 text-white/60">Página <strong>${tableCurrentPage}</strong> de <strong>${totalPages}</strong></span>
      <button data-action="navigate-page" data-direction="1" ${tableCurrentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 bg-white/5 rounded-lg border border-white/10 transition ${tableCurrentPage >= totalPages ? 'opacity-30 cursor-not-allowed' : 'hover:text-[#C5A059] active:scale-95'}">Próxima</button>
    </div>
  `;
}

function renderAdvTable(tbodyId, advStats) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const sortedAdversarios = Object.keys(advStats).sort((a, b) => {
    const sA = advStats[a], sB = advStats[b];
    if (sB.jog !== sA.jog) return sB.jog - sA.jog;
    const apA = ((sA.v * 3) + sA.e) / (sA.jog * 3);
    const apB = ((sB.v * 3) + sB.e) / (sB.jog * 3);
    return apB - apA;
  });

  if (sortedAdversarios.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="p-6 text-center text-white/40 italic">Nenhum confronto encontrado para os filtros atuais.</td></tr>`;
    return;
  }

  tbody.innerHTML = sortedAdversarios.map(adv => {
    const s = advStats[adv];
    const sg = s.gp - s.gc;
    const pts = (s.v * 3) + s.e;
    const ap = ((pts / (s.jog * 3)) * 100).toFixed(1) + '%';
    const sgColor = sg > 0 ? 'text-emerald-400' : sg < 0 ? 'text-rose-400' : 'text-white/70';

    return `<tr class="hover:bg-white/[0.04] transition border-b border-white/5">
      <td class="p-3 font-sans font-bold text-white">${escapeHtml(adv)}</td>
      <td class="p-3 text-center text-white/90 font-bold">${s.jog}</td>
      <td class="p-3 text-center text-emerald-400 font-bold">${s.v}</td>
      <td class="p-3 text-center text-amber-300">${s.e}</td>
      <td class="p-3 text-center text-rose-400">${s.d}</td>
      <td class="p-3 text-center text-cyan-300">${s.gp.toLocaleString('pt-BR')}</td>
      <td class="p-3 text-center text-purple-300">${s.gc.toLocaleString('pt-BR')}</td>
      <td class="p-3 text-center font-bold ${sgColor}">${sg > 0 ? '+' + sg.toLocaleString('pt-BR') : sg.toLocaleString('pt-BR')}</td>
      <td class="p-3 text-right text-[#C5A059] font-bold">${ap}</td>
    </tr>`;
  }).join('');
}

function navigatePage(direction) {
  const validFiltered = filteredMatches;
  const totalPages = Math.ceil(validFiltered.length / tablePageSize) || 1;
  const newPage = tableCurrentPage + direction;
  if (newPage >= 1 && newPage <= totalPages) {
    tableCurrentPage = newPage;
    renderTable();
  }
}

// --- TAB CLÁSSICOS ---
function initClassicosSlider() {
  if (CLASSICOS_DATA.length === 0) return;
  const years = CLASSICOS_DATA.map(c => c.ano).filter(a => !isNaN(a) && a > 1900);
  if (years.length === 0) return;
  
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  const minInput = document.getElementById('classicos-ano-min');
  const maxInput = document.getElementById('classicos-ano-max');
  
  if(minInput && maxInput) {
    minInput.min = minYear; minInput.max = maxYear;
    maxInput.min = minYear; maxInput.max = maxYear;
    
    if (!classicosState.minAno || classicosState.minAno < minYear) classicosState.minAno = minYear;
    if (!classicosState.maxAno || classicosState.maxAno > maxYear) classicosState.maxAno = maxYear;
    
    minInput.value = classicosState.minAno;
    maxInput.value = classicosState.maxAno;
    
    updateClassicosSliderUI();
  }
}

function updateClassicosSliderUI() {
  const minInput = document.getElementById('classicos-ano-min');
  const maxInput = document.getElementById('classicos-ano-max');
  const track = document.getElementById('classicos-slider-track');
  const valuesDisplay = document.getElementById('classicos-slider-values');
  
  if(!minInput || !maxInput || !track) return;

  let minVal = parseInt(minInput.value);
  let maxVal = parseInt(maxInput.value);
  
  if (minVal > maxVal) {
    let tmp = minVal;
    minVal = maxVal;
    maxVal = tmp;
  }

  minInput.value = minVal;
  maxInput.value = maxVal;
  
  classicosState.minAno = minVal;
  classicosState.maxAno = maxVal;

  if(valuesDisplay) valuesDisplay.textContent = `${minVal} - ${maxVal}`;
  
  const range = parseInt(minInput.max) - parseInt(minInput.min);
  if (range > 0) {
    const leftPercent = ((minVal - parseInt(minInput.min)) / range) * 100;
    const rightPercent = ((maxVal - parseInt(minInput.min)) / range) * 100;
    track.style.left = leftPercent + '%';
    track.style.width = (rightPercent - leftPercent) + '%';
  }
}

function toggleClassicosDropdown(type) {
  const targetPanel = document.getElementById(`classicos-panel-${type}`);
  const isClosed = targetPanel.classList.contains('hidden');
  document.querySelectorAll('.ms-dropdown-menu').forEach(p => p.classList.add('hidden'));
  if (isClosed) targetPanel.classList.remove('hidden');
}

function getClassicosExcluding(excludeDimension) {
  const setComp = excludeDimension !== 'competicao' && classicosState.competicao.length > 0 ? new Set(classicosState.competicao) : null;
  const setAdv = excludeDimension !== 'adversario' && classicosState.adversario.length > 0 ? new Set(classicosState.adversario) : null;
  const setPres = excludeDimension !== 'presente' && classicosState.presente.length > 0 ? new Set(classicosState.presente) : null;

  return CLASSICOS_DATA.filter(m => {
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (classicosState.minAno && m.ano < classicosState.minAno) return false;
    if (classicosState.maxAno && m.ano > classicosState.maxAno) return false;
    return true;
  });
}

function renderClassicosChecklist(type, items, matchingSubset) {
  const container = document.getElementById(`classicos-list-${type}`);
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = '<div class="text-[11px] text-white/40 p-2 text-center italic">Nenhuma opção disponível</div>';
    return;
  }

  const counts = {};
  matchingSubset.forEach(m => {
    let val;
    if (type === 'competicao') val = m.torneio;
    else if (type === 'adversario') val = m.adv;
    else val = m[type];
    counts[val] = (counts[val] || 0) + 1;
  });

  const checkedSet = new Set(classicosState[type]);
  const html = items.map(item => {
    const count = counts[item.value] || 0;
    const isChecked = checkedSet.has(item.value);
    return `
      <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded-lg cursor-pointer text-xs text-white/90 transition select-none">
        <div class="flex items-center gap-2 truncate pr-1">
          <input type="checkbox" class="ms-checkbox rounded" value="${escapeHtml(item.value)}" ${isChecked ? 'checked' : ''} data-change-action="classicos-checkbox" data-filter="${escapeHtml(type)}">
          <span class="truncate">${escapeHtml(item.label)}</span>
        </div>
        <span class="text-[10px] text-white/40 font-mono shrink-0">${count}</span>
      </label>
    `;
  }).join('');
  container.innerHTML = html;
}

function updateClassicosDropdowns() {
  const comps = [...new Set(CLASSICOS_DATA.map(m => m.torneio))].filter(c => c && c !== "-").sort();
  renderClassicosChecklist('competicao', comps.map(c => ({ value: c, label: c })), getClassicosExcluding('competicao'));

  const opponents = [...new Set(CLASSICOS_DATA.map(m => m.adv))].filter(a => a && a !== "-" && a !== "A Definir").sort((a, b) => a.localeCompare(b, 'pt-BR'));
  renderClassicosChecklist('adversario', opponents.map(adv => ({ value: adv, label: adv })), getClassicosExcluding('adversario'));

  const presentes = [...new Set(CLASSICOS_DATA.map(m => m.presente))].filter(p => p).sort();
  renderClassicosChecklist('presente', presentes.map(p => ({ value: p, label: p })), getClassicosExcluding('presente'));
}

function onClassicosCheckboxChange(type, value, isChecked) {
  if (isChecked) {
    if (!classicosState[type].includes(value)) classicosState[type].push(value);
  } else {
    classicosState[type] = classicosState[type].filter(v => v !== value);
  }
  applyClassicosFilters();
}

function selectClassicosAll(type, selectAll) {
  const container = document.getElementById(`classicos-list-${type}`);
  if (!container) return;
  classicosState[type] = [];
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = selectAll;
    if (selectAll) classicosState[type].push(cb.value);
  });
  applyClassicosFilters();
}

function updateClassicosLabels() {
  const types = ['competicao', 'adversario', 'presente'];
  types.forEach(t => {
    const count = classicosState[t].length;
    const labelEl = document.getElementById(`classicos-label-${t}`);
    if (!labelEl) return;
    const totalItems = document.querySelectorAll(`#classicos-list-${t} input[type="checkbox"]`).length;
    if (count === 0) {
      labelEl.textContent = 'Todas';
      labelEl.className = 'truncate pr-1 text-white/80';
    } else if (count === totalItems && totalItems > 1) {
      labelEl.textContent = 'Todas Selecionadas';
      labelEl.className = 'truncate pr-1 text-emerald-300 font-semibold';
    } else if (count === 1) {
      labelEl.textContent = classicosState[t][0];
      labelEl.className = 'truncate pr-1 text-[#C5A059] font-semibold';
    } else {
      labelEl.textContent = `${count} selecionados`;
      labelEl.className = 'truncate pr-1 text-[#C5A059] font-semibold';
    }
  });
}


// V3.2.54 — Comparativo calculado somente com os clássicos filtrados.
function renderClassicosComparison(statsByOpponent) {
 const container=document.getElementById('classicos-comparison-bars');
 if(!container)return;
 const rivals=[['Flamengo','flamengo'],['Vasco','vasco'],['Botafogo','botafogo']];
 container.replaceChildren();
 rivals.forEach(([name,key])=>{
  const stats={v:0,e:0,d:0,gp:0,gc:0};
  Object.entries(statsByOpponent).forEach(([opponent,values])=>{
   if(normalizeComparable(opponent).includes(key)){
    ['v','e','d','gp','gc'].forEach(k=>stats[k]+=values[k]||0);
   }
  });
  const total=stats.v+stats.e+stats.d,saldo=stats.v-stats.d;
  const row=document.createElement('div');row.className='classicos-comparison-row';
  const header=document.createElement('div');header.className='classicos-comparison-header';
  const label=document.createElement('div');label.className='classicos-comparison-label';
  label.textContent=`Fluminense × ${name}`;
  const count=document.createElement('span');count.className='classicos-comparison-total';
  count.textContent=total.toLocaleString('pt-BR')+' jogos';
  header.append(label);
  const bar=document.createElement('div');bar.className='classicos-comparison-bar';
  bar.setAttribute('role','img');bar.setAttribute('aria-label',`${name}: ${stats.v} vitórias do Fluminense, ${stats.e} empates, ${stats.d} derrotas. Saldo ${saldo}`);
  if(!total){const empty=document.createElement('span');empty.className='classicos-comparison-empty';empty.textContent='Sem partidas no recorte';bar.append(empty);}
  else [['win',stats.v,'Vitórias'],['draw',stats.e,'Empates'],['loss',stats.d,'Derrotas']].forEach(([kind,value,title])=>{
   if(!value)return;
   const segment=document.createElement('span');segment.className='classicos-comparison-segment classicos-comparison-'+kind;
   segment.style.width=(value/total*100)+'%';segment.textContent=value.toLocaleString('pt-BR');
   segment.title=`${title}: ${value} (${(value/total*100).toFixed(1)}%)`;
   bar.append(segment);
  });
  const metrics=document.createElement('div');metrics.className='classicos-comparison-metrics';
  const rate=total?(stats.v*3+stats.e)/(total*3)*100:0;
  [['Aproveitamento',total?rate.toFixed(1).replace('.',',')+'%':'—'],['Gols pró',stats.gp.toLocaleString('pt-BR')],['Gols contra',stats.gc.toLocaleString('pt-BR')],['Saldo (V-D)',total?(saldo>0?'+':'')+saldo:'—']].forEach(([title,value],i)=>{
   const metric=document.createElement('div');metric.className='classicos-comparison-metric';
   const heading=document.createElement('small');heading.textContent=title;
   const number=document.createElement('strong');number.textContent=value;
   if(i===0&&total)number.style.color=recentRateColor(rate);
   if(i===3&&total)number.classList.add(saldo>0?'saldo-positive':saldo<0?'saldo-negative':'saldo-neutral');
   metric.append(heading,number);metrics.append(metric);
  });
  const results=document.createElement('div');results.className='classicos-comparison-results';
  header.append(count);
  results.append(bar);
  row.append(header,results,metrics);container.append(row);
 });
}

function resetClassicosFilters() {
  classicosState.competicao = [];
  classicosState.adversario = [];
  classicosState.presente = [];
  
  if (CLASSICOS_DATA.length > 0) {
    const years = CLASSICOS_DATA.map(c => c.ano).filter(a => !isNaN(a) && a > 1900);
    classicosState.minAno = Math.min(...years);
    classicosState.maxAno = Math.max(...years);
  }

  initClassicosSlider();
  applyClassicosFilters();
}

function applyClassicosFilters() {
  updateClassicosDropdowns();
  updateClassicosLabels();

  const setComp = classicosState.competicao.length > 0 ? new Set(classicosState.competicao) : null;
  const setAdv = classicosState.adversario.length > 0 ? new Set(classicosState.adversario) : null;
  const setPres = classicosState.presente.length > 0 ? new Set(classicosState.presente) : null;

  const filteredClassicos = CLASSICOS_DATA.filter(m => {
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (classicosState.minAno && m.ano < classicosState.minAno) return false;
    if (classicosState.maxAno && m.ano > classicosState.maxAno) return false;
    return true;
  });

  currentFilteredClassicos = filteredClassicos;

  const tag = document.getElementById('classicos-matches-tag');
  if (tag) tag.textContent = `${filteredClassicos.length} partidas`;

  let v = 0, e = 0, d = 0, gp = 0, gc = 0;
  const advStatsClassicos = {};
  const classicosIndexByYearAdv = {};

  filteredClassicos.forEach(m => {
    // Indexa por ano + rival normalizado para cruzamento O(1) com Setor Sul
    const key = `${m.ano}_${m.advNorm}`;
    if (!classicosIndexByYearAdv[key]) classicosIndexByYearAdv[key] = [];
    classicosIndexByYearAdv[key].push(m.timestamp);

    if (m.gf !== null && m.ga !== null) {
       const fluGols = m.gf, advGols = m.ga;
       gp += fluGols;
       gc += advGols;
       
       let res = 'E';
       if (fluGols > advGols) { v++; res = 'V'; }
       else if (fluGols < advGols) { d++; res = 'D'; }
       else { e++; res = 'E'; }

       if (!advStatsClassicos[m.adv]) {
           advStatsClassicos[m.adv] = { jog: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0 };
       }
       const st = advStatsClassicos[m.adv];
       st.jog++; st.gp += fluGols; st.gc += advGols;
       if (res === 'V') st.v++; else if (res === 'E') st.e++; else st.d++;
    }
  });

  renderClassicosComparison(advStatsClassicos);

  const total = filteredClassicos.length;
  const ptsPossiveis = total * 3;
  const ptsGanhos = (v * 3) + e;
  const aprov = ptsPossiveis > 0 ? ((ptsGanhos / ptsPossiveis) * 100).toFixed(1) + '%' : '0%';

  document.getElementById('classicos-kpi-vitorias').textContent = v;
  document.getElementById('classicos-sub-vitorias').textContent = total > 0 ? `${((v/total)*100).toFixed(1)}% dos jogos` : '0%';
  document.getElementById('classicos-kpi-empates').textContent = e;
  document.getElementById('classicos-sub-empates').textContent = total > 0 ? `${((e/total)*100).toFixed(1)}% dos jogos` : '0%';
  document.getElementById('classicos-kpi-derrotas').textContent = d;
  document.getElementById('classicos-sub-derrotas').textContent = total > 0 ? `${((d/total)*100).toFixed(1)}% dos jogos` : '0%';
  
  document.getElementById('classicos-kpi-gp').textContent = gp.toLocaleString('pt-BR');
  document.getElementById('classicos-sub-gp').textContent = total > 0 ? `Média ${(gp/total).toFixed(2)} por jogo` : '0';
  document.getElementById('classicos-kpi-gc').textContent = gc.toLocaleString('pt-BR');
  document.getElementById('classicos-sub-gc').textContent = total > 0 ? `Média ${(gc/total).toFixed(2)} por jogo` : '0';
  
  document.getElementById('classicos-kpi-aproveitamento').textContent = aprov;
  document.getElementById('classicos-sub-aproveitamento').textContent = `${ptsGanhos} de ${ptsPossiveis} pts`;

  updateClassicosPerformanceInsights();
  updateClassicosChart(filteredClassicos);

  // Cruzamento ultra-rápido por chave indexada (Ano + Rival + Tolerância de 4 dias)
  const isMatchInFilteredClassicos = (m) => {
    const timestamps = classicosIndexByYearAdv[`${m.ano}_${m.advNorm}`];
    if (!timestamps) return false;
    for (let i = 0; i < timestamps.length; i++) {
      if (Math.abs(m.timestamp - timestamps[i]) <= 345600000) return true;
    }
    return false;
  };

  const sulMatchesClassicos = [];
  let missingSulCountClassicos = 0;

  MATCHES_DATA.forEach(m => {
    if (!m.isMaracanaNorm) return;
    if (!isMatchInFilteredClassicos(m)) return;
    if (m.sul !== null && m.sul > 0) {
      sulMatchesClassicos.push(m);
    } else {
      missingSulCountClassicos++;
    }
  });

  const avgSulClassicos = sulMatchesClassicos.length ? sulMatchesClassicos.reduce((acc, x) => acc + x.sul, 0) / sulMatchesClassicos.length : 0;
  
  let xxxx = "-", yyyy = "-";
  if (sulMatchesClassicos.length > 0) {
      const years = sulMatchesClassicos.map(m => m.ano).filter(y => !isNaN(y));
      xxxx = Math.min(...years);
      yyyy = Math.max(...years);
  }
  
  const elMediaSul = document.getElementById("classicos-kpi-media-sul");
  const elSubSul = document.getElementById("classicos-kpi-sub-sul");
  if (elMediaSul) elMediaSul.textContent = sulMatchesClassicos.length > 0 ? fmt(avgSulClassicos) : "-";
  if (elSubSul) elSubSul.textContent = sulMatchesClassicos.length > 0 ? `${sulMatchesClassicos.length} jogos (${xxxx} - ${yyyy})` : "Sem dados do Setor Sul";

  const taxaSulClassicos = avgSulClassicos > 0 ? (avgSulClassicos / CONFIG.capacidadeSulPagantes) * 100 : 0;
  const elTaxaSul = document.getElementById("classicos-kpi-taxa-sul");
  if (elTaxaSul) elTaxaSul.textContent = taxaSulClassicos > 0 ? `${taxaSulClassicos.toFixed(1)}%` : "-";

  const recordedCountEl = document.getElementById("classicos-sul-recorded-count");
  if (recordedCountEl) recordedCountEl.textContent = `${sulMatchesClassicos.length} jogos`;

  const alertRecordsEl = document.getElementById("classicos-sul-alert-records");
  if (alertRecordsEl) {
      if (sulMatchesClassicos.length > 0) {
          document.getElementById("classicos-sul-record-z").textContent = sulMatchesClassicos.length;
          document.getElementById("classicos-sul-record-x").textContent = xxxx;
          document.getElementById("classicos-sul-record-y").textContent = yyyy;
          alertRecordsEl.classList.remove("hidden");
      } else {
          alertRecordsEl.classList.add("hidden");
      }
  }

  const classicosAlertEl = document.getElementById("classicos-sul-alert-missing");
  const classicosCountEl = document.getElementById("classicos-sul-missing-count");
  if (classicosAlertEl && classicosCountEl) {
    if (missingSulCountClassicos > 0) {
      classicosCountEl.textContent = missingSulCountClassicos;
      classicosAlertEl.classList.remove("hidden");
    } else {
      classicosAlertEl.classList.add("hidden");
    }
  }

  const topSulMatchesClassicos = [...sulMatchesClassicos]
    .sort((a, b) => b.sul - a.sul)
    .slice(0, 10);

  renderSulBarChart("chartClassicosSetorSul", topSulMatchesClassicos);
  renderClassicosTable(filteredClassicos);
  renderAdvTable('classicos-adv-table-body', advStatsClassicos);
}


let classicosStreaks = { wins: [], unbeaten: [] };
let expandedClassicosStreak = null;

function renderClassicosStreakMatches(type) {
 const container=document.getElementById(`classicos-streak-${type}-matches`);
 if(!container)return;
 const matches=classicosStreaks[type] || [];
 if(!matches.length){container.textContent='Nenhuma partida para exibir.';return;}
 const ordered=matches.slice().sort((a,b)=>(a.timestamp||computeTimestamp(a.data))-(b.timestamp||computeTimestamp(b.data)));
 container.innerHTML=sharedDetailsHeader()+ordered.map(m=>sharedDetailsRow(sharedMatchDate(m),m.adv,m.placar,m.torneio,getMatchResult(m))).join('');
}

function syncClassicosStreakExpansion() {
  ['wins', 'unbeaten'].forEach(type => {
    const button = document.querySelector(`[data-action="toggle-classicos-streak-matches"][data-streak="${type}"]`);
    const container = document.getElementById(`classicos-streak-${type}-matches`);
    const open = expandedClassicosStreak === type;
    if (button) {
      button.setAttribute('aria-expanded', String(open));
      button.innerHTML = open ? 'Ocultar partidas <span aria-hidden="true">⌃</span>' : 'Ver partidas <span aria-hidden="true">›</span>';
      button.disabled = !(classicosStreaks[type] || []).length;
    }
    if (container) container.hidden = !open;
    if (open) renderClassicosStreakMatches(type);
  });
}

function toggleClassicosStreakMatches(type) {
  if (!['wins', 'unbeaten'].includes(type) || !(classicosStreaks[type] || []).length) return;
  expandedClassicosStreak = expandedClassicosStreak === type ? null : type;
  syncClassicosStreakExpansion();
}

let classicosRecentMatches = [];
let expandedClassicosRecentForm = false;

function renderClassicosRecentFormMatches() {
 const container=document.getElementById('classicos-recent-form-matches');
 if(!container)return;
 const matches=classicosRecentMatches;
 if(!matches.length){container.textContent='Nenhuma partida para exibir.';return;}
 const ordered=matches;
 container.innerHTML=sharedDetailsHeader()+ordered.map(m=>sharedDetailsRow(sharedMatchDate(m),m.adv,m.placar,m.torneio,getMatchResult(m))).join('');
}

function syncClassicosRecentFormExpansion() {
  const button = document.querySelector('[data-action="toggle-classicos-recent-form-matches"]');
  const container = document.getElementById('classicos-recent-form-matches');
  if (button) {
    button.disabled = !classicosRecentMatches.length;
    button.setAttribute('aria-expanded', String(expandedClassicosRecentForm));
    button.innerHTML = expandedClassicosRecentForm ? 'Ocultar partidas <span aria-hidden="true">⌃</span>' : 'Ver partidas <span aria-hidden="true">›</span>';
  }
  if (container) container.hidden = !expandedClassicosRecentForm;
  if (expandedClassicosRecentForm) renderClassicosRecentFormMatches();
}

function toggleClassicosRecentFormMatches() {
  if (!classicosRecentMatches.length) return;
  expandedClassicosRecentForm = !expandedClassicosRecentForm;
  syncClassicosRecentFormExpansion();
}

function getFilteredClassicosForInsights() {
  const setComp = classicosState.competicao.length ? new Set(classicosState.competicao) : null;
  const setAdv = classicosState.adversario.length ? new Set(classicosState.adversario) : null;
  const setPres = classicosState.presente.length ? new Set(classicosState.presente) : null;
  return CLASSICOS_DATA.filter(m => {
    if (setComp && !setComp.has(m.torneio)) return false;
    if (setAdv && !setAdv.has(m.adv)) return false;
    if (setPres && !setPres.has(m.presente)) return false;
    if (classicosState.minAno && m.ano < classicosState.minAno) return false;
    if (classicosState.maxAno && m.ano > classicosState.maxAno) return false;
    return true;
  });
}

function updateClassicosPerformanceInsights() {
  const data = getFilteredClassicosForInsights();
  const scored = data.filter(m => getMatchResult(m));
  const recent = scored.slice().sort((a,b) => (b.timestamp || computeTimestamp(b.data)) - (a.timestamp || computeTimestamp(a.data))).slice(0,5).reverse();
  classicosRecentMatches = recent;
  if (expandedClassicosRecentForm && !recent.length) expandedClassicosRecentForm = false;
  const results = document.getElementById('classicos-recent-form-results');
  if (results) results.innerHTML = recent.length ? recent.map(m => {
    const r=getMatchResult(m);
    return `<span class="recent-result recent-result-${r.toLowerCase()}" title="${escapeHtml(m.data)} · ${escapeHtml(m.adv)} · ${escapeHtml(m.placar)}">${r}</span>`;
  }).join('') : '<span class="text-xs text-white/40">Sem jogos com placar no recorte.</span>';
  const wins=recent.filter(m=>getMatchResult(m)==='V').length;
  const draws=recent.filter(m=>getMatchResult(m)==='E').length;
  const possible=recent.length*3, points=wins*3+draws;
  const gf=recent.reduce((sum,m)=>sum+(Number.isFinite(m.gf)?m.gf:0),0);
  const ga=recent.reduce((sum,m)=>sum+(Number.isFinite(m.ga)?m.ga:0),0);
  const rateEl=document.getElementById('classicos-recent-form-rate');
  if (rateEl) { const rate=possible?Math.round(points/possible*100):null; rateEl.textContent=rate!==null?`${rate}%`:'-'; rateEl.style.color=rate!==null?recentRateColor(rate):''; }
  const gfEl=document.getElementById('classicos-recent-form-gf'); if(gfEl) gfEl.textContent=recent.length?gf.toLocaleString('pt-BR'):'-';
  const gaEl=document.getElementById('classicos-recent-form-ga'); if(gaEl) gaEl.textContent=recent.length?ga.toLocaleString('pt-BR'):'-';

  const winStreak=calculateLongestStreak(data,r=>r==='V');
  const unbeatenStreak=calculateLongestStreak(data,r=>r==='V'||r==='E');
  classicosStreaks={wins:winStreak,unbeaten:unbeatenStreak};
  if(expandedClassicosStreak && !classicosStreaks[expandedClassicosStreak].length) expandedClassicosStreak=null;
  const wc=document.getElementById('classicos-streak-wins-count'), wp=document.getElementById('classicos-streak-wins-period');
  const uc=document.getElementById('classicos-streak-unbeaten-count'), up=document.getElementById('classicos-streak-unbeaten-period'), ub=document.getElementById('classicos-streak-unbeaten-breakdown');
  if(wc) wc.textContent=winStreak.length||'0';
  if(wp) wp.textContent=winStreak.length?formatMatchPeriod(winStreak[0],winStreak[winStreak.length-1]):'Nenhuma vitória no recorte';
  if(uc) uc.textContent=unbeatenStreak.length||'0';
  if(up) {
    if(unbeatenStreak.length){ const v=unbeatenStreak.filter(m=>getMatchResult(m)==='V').length, e=unbeatenStreak.length-v; up.textContent=formatMatchPeriod(unbeatenStreak[0],unbeatenStreak[unbeatenStreak.length-1]); if(ub) ub.textContent=`(${v}V / ${e}E)`; }
    else { up.textContent='Nenhuma sequência no recorte'; if(ub) ub.textContent=''; }
  }
  syncClassicosStreakExpansion();
  syncClassicosRecentFormExpansion();
}

let classicosSaldoMode = 'anos';
let rivalsSaldoMode = 'anos';
let lastClassicosSaldoData = null;
function updateClassicosChart(data) {
  lastClassicosSaldoData = data;
  const sortedData = [...data].sort((a, b) => a.sortTime - b.sortTime);

  let vFla = 0, vVas = 0, vBot = 0, vTot = 0;
  const labels = [], dFla = [], dVas = [], dBot = [], dTot = [];

  sortedData.forEach(c => {
     if (c.gf !== null && c.ga !== null) {
         const diff = c.gf - c.ga;
         if (diff > 0) {
             vTot++;
             if (c.advNorm === 'flamengo') vFla++;
             else if (c.advNorm === 'vasco') vVas++;
             else if (c.advNorm === 'botafogo') vBot++;
         } else if (diff < 0) {
             vTot--;
             if (c.advNorm === 'flamengo') vFla--;
             else if (c.advNorm === 'vasco') vVas--;
             else if (c.advNorm === 'botafogo') vBot--;
         }
     }
     
     labels.push(c.data);
     dFla.push(vFla);
     dVas.push(vVas);
     dBot.push(vBot);
     dTot.push(vTot);
  });

  // Annual view takes the final cumulative balance of each year, without resetting.
  if (classicosSaldoMode === 'anos') {
    const finalByYear = new Map();
    sortedData.forEach((match, i) => {
      const year = new Date(match.sortTime).getFullYear();
      if (Number.isFinite(year)) finalByYear.set(year, i);
    });
    const indices = [...finalByYear.entries()].sort((a,b)=>a[0]-b[0]);
    const annualLabels = indices.map(([year])=>String(year));
    const pick = arr => indices.map(([,i])=>arr[i]);
    labels.splice(0,labels.length,...annualLabels);
    for (const arr of [dFla,dVas,dBot,dTot]) {
      const annual = pick(arr);
      arr.splice(0,arr.length,...annual);
    }
  }

  const selAdv = classicosState.adversario.map(a => a.toLowerCase());
  const showAll = selAdv.length === 0;
  const showBot = showAll || selAdv.some(a => a.includes('botafogo'));
  const showVas = showAll || selAdv.some(a => a.includes('vasco'));
  const showFla = showAll || selAdv.some(a => a.includes('flamengo'));

  const activeRivalsCount = [showBot, showVas, showFla].filter(Boolean).length;
  const isSingleRival = activeRivalsCount === 1;

  const datasets = [];

  if (!isSingleRival) {
      datasets.push({ 
          label: 'Saldo Total', 
          data: dTot, 
          borderColor: '#22c55e', 
          backgroundColor: '#22c55e', 
          borderWidth: 2.5, 
          tension: 0, 
          pointRadius: 0, 
          pointHoverRadius: 5 
      });
  }

  if (showBot) {
      datasets.push({ 
          label: 'Botafogo', 
          data: dBot, 
          borderColor: document.documentElement.dataset.theme === 'light' ? '#171717' : '#ffffff', 
          backgroundColor: document.documentElement.dataset.theme === 'light' ? '#171717' : '#ffffff', 
          borderWidth: isSingleRival ? 2.5 : 1.5, 
          tension: 0, 
          pointRadius: 0, 
          pointHoverRadius: 4 
      });
  }
  if (showVas) {
      datasets.push({ 
          label: 'Vasco', 
          data: dVas, 
          borderColor: '#9ca3af', 
          backgroundColor: '#9ca3af', 
          borderWidth: isSingleRival ? 2.5 : 1.5, 
          tension: 0, 
          pointRadius: 0, 
          pointHoverRadius: 4 
      });
  }
  if (showFla) {
      datasets.push({ 
          label: 'Flamengo', 
          data: dFla, 
          borderColor: '#ef4444', 
          backgroundColor: '#ef4444', 
          borderWidth: isSingleRival ? 2.5 : 1.5, 
          tension: 0, 
          pointRadius: 0, 
          pointHoverRadius: 4 
      });
  }

  if (activeCharts["chartEvolucaoClassicos"]) activeCharts["chartEvolucaoClassicos"].destroy();
  
  activeCharts["chartEvolucaoClassicos"] = new Chart(document.getElementById("chartEvolucaoClassicos").getContext('2d'), {
     type: 'line',
     data: {
         labels: labels,
         datasets: datasets
     },
     options: {
         responsive: true, maintainAspectRatio: false,
         interaction: { mode: 'index', intersect: false },
         plugins: { 
             legend: { position: 'bottom', labels: { color: (document.documentElement.dataset.theme === 'light' ? '#385642' : 'rgba(255,255,255,0.7)'), usePointStyle: true, boxWidth: 8 } },
             tooltip: { callbacks: { title: (items) => `${classicosSaldoMode === 'anos' ? 'Ano' : 'Data'}: ${items[0].label}` } }
         },
         scales: {
             x: { ticks: { maxTicksLimit: 10, color: () => evolucaoSaldoThemeColors().tick }, grid: { display: false } },
             y: { 
                 grid: { 
                     color: (ctx) => ctx.tick?.value === 0 ? evolucaoSaldoThemeColors().zero : evolucaoSaldoThemeColors().grid,
                     lineWidth: (ctx) => ctx.tick?.value === 0 ? 2 : 1
                 }, 
                 ticks: { color: () => evolucaoSaldoThemeColors().tick }
             }
         }
     }
  });
}

function evolucaoSaldoThemeColors() {
  const light = document.documentElement.dataset.theme === 'light';
  return {
    tick: light ? '#52675A' : 'rgba(255,255,255,0.65)',
    grid: light ? 'rgba(35,90,58,0.14)' : 'rgba(255,255,255,0.07)',
    zero: light ? '#52675A' : 'rgba(185,205,195,0.65)'
  };
}

function renderClassicosTable(data) {
  const tbody = document.getElementById('classicos-table-body');
  if (!tbody) return;
  const sorted = sortedTableData(data, classicosTableSort);
  renderCatalogSummary('classicos', sorted.length);
  updateSortIndicators('classicos', classicosTableSort);
  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-white/40 italic">Nenhum clássico encontrado para os filtros selecionados.</td></tr>`;
    return;
  }
  tbody.innerHTML = sorted.map(c => `<tr class="hover:bg-white/[0.04] transition border-b border-white/5">
      <td class="p-3 text-white/90">${escapeHtml(formatCatalogDate(c.data))}</td>
      <td class="p-3 font-sans font-bold text-white">${escapeHtml(c.adv)}</td>
      <td class="p-3 text-center">${resultBadge(c)}</td>
      <td class="p-3 font-sans text-[11px] text-white/80 max-w-[170px] truncate" title="${escapeHtml(c.torneio)}">${escapeHtml(c.torneio)}</td>
    </tr>`).join('');
}

// Recuperação responsiva: corrige canvases restaurados com dimensões incorretas
// após retorno à página/aba, rotação ou redimensionamento no mobile.
let chartRecoveryTimer = null;
function recoverChartSizes() {
  if (chartRecoveryTimer) clearTimeout(chartRecoveryTimer);
  chartRecoveryTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        Object.values(activeCharts).forEach(chart => {
          if (!chart || typeof chart.resize !== 'function') return;
          try {
            chart.resize();
            chart.update('none');
          } catch (err) {
            console.warn('Não foi possível reajustar um gráfico:', err);
          }
        });
      });
    });
  }, 80);
}

function initChartRecoveryHandlers() {
  window.addEventListener('pageshow', recoverChartSizes);
  window.addEventListener('resize', recoverChartSizes, { passive: true });
  window.addEventListener('orientationchange', recoverChartSizes, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverChartSizes();
  });
}

// --- CAMADA DE EVENTOS / BOOTSTRAP (V3.0) ---
function handleDelegatedClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const actions = {
    'refresh-data': () => fetchLiveGoogleSheet(),
    'toggle-data-notice': () => toggleDataNotice(),
    'toggle-public-filters': () => togglePublicFilters(),
    'toggle-streak-matches': () => toggleStreakMatches(target.dataset.streak),
    'toggle-recent-form-matches': () => toggleRecentFormMatches(),
    'toggle-classicos-streak-matches': () => toggleClassicosStreakMatches(target.dataset.streak),
    'toggle-classicos-recent-form-matches': () => toggleClassicosRecentFormMatches(),
    'reset-filters': () => resetFilters(),
    'toggle-sem-rivais': () => toggleSemRivais(),
    'reset-classicos-filters': () => resetClassicosFilters(),
    'reset-rivals-filters': () => resetRivalsFilters(),
    'copy-filtered-url': () => copyFilteredUrl(),
    'export-filtered-csv': () => exportFilteredCsv(),
    'export-classicos-csv': () => exportClassicosFilteredCsv(),
    'navigate-page': () => navigatePage(Number(target.dataset.direction)),
    'sort-catalog': () => sortCatalog(target.dataset.sortScope, target.dataset.sortKey),
    'switch-tab': () => switchTab(target.dataset.tab),
    'toggle-rivals-menu': () => toggleRivalsMenu(),
    'open-rivals': () => openRivalsView(),
    'saldo-mode': () => setSaldoMode(target.dataset.saldoView, target.dataset.saldoMode),
    'rivals-tab': () => setRivalsTab(target.dataset.rivalsTab),
    'rivals-toggle-recent': () => toggleRivalsInsight('recent'),
    'rivals-toggle-wins': () => toggleRivalsInsight('wins'),
    'rivals-toggle-unbeaten': () => toggleRivalsInsight('unbeaten'),
    'switch-table-tab': () => switchTableTab(target.dataset.tab),
    'switch-classicos-table-tab': () => switchClassicosTableTab(target.dataset.tab),
    'toggle-dropdown': () => toggleDropdown(target.dataset.filter),
    'toggle-classicos-dropdown': () => toggleClassicosDropdown(target.dataset.filter),
    'select-all-filter': () => selectAllFilter(target.dataset.filter, target.dataset.select === 'true'),
    'select-classicos-all': () => selectClassicosAll(target.dataset.filter, target.dataset.select === 'true')
  };

  actions[target.dataset.action]?.();
}

function handleDelegatedInput(event) {
  const target = event.target.closest('[data-input-action]');
  if (!target) return;

  if (target.dataset.inputAction === 'debounced-apply-filters') debouncedApplyFilters();
  if (target.dataset.inputAction === 'filter-dropdown-options') filterDropdownOptions(target.dataset.filter, target.value);
  if (target.dataset.inputAction === 'classicos-slider-ui') updateClassicosSliderUI();
}

function handleDelegatedChange(event) {
  const target = event.target.closest('[data-change-action]');
  if (!target) return;

  if (target.dataset.changeAction === 'apply-classicos-filters') applyClassicosFilters();
  if (target.dataset.changeAction === 'filter-checkbox') onCheckboxChange(target.dataset.filter, target.value, target.checked);
  if (target.dataset.changeAction === 'classicos-checkbox') onClassicosCheckboxChange(target.dataset.filter, target.value, target.checked);
}

function initEventHandlers() {
  document.addEventListener('click', handleDelegatedClick);
  document.addEventListener('input', handleDelegatedInput);
  document.addEventListener('change', handleDelegatedChange);
}

function initDashboard() {
  applyDashboardTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  initEventHandlers();
  initChartRecoveryHandlers();
  restoreFiltersFromUrl();
  initPublicFiltersPanel();
  if (window.lucide) lucide.createIcons();
  fetchLiveGoogleSheet();
}



function renderDashboardVersion() {
  const versionEl = document.getElementById('dashboard-version');
  if (versionEl) versionEl.textContent = `v${DASHBOARD_VERSION}`;
}
document.addEventListener('DOMContentLoaded', initDashboard);

// Tema visual: o padrão permanece escuro e a preferência é local ao navegador.
function applyDashboardTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const button = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-toggle-label');
  if (button) {
    button.setAttribute('aria-pressed', String(light));
    button.setAttribute('aria-label', light ? 'Ativar modo escuro' : 'Ativar modo claro');
    button.title = light ? 'Ativar modo escuro' : 'Ativar modo claro';
  }
  if (label) label.textContent = light ? 'Escuro' : 'Claro';
  try { localStorage.setItem('flu-dashboard-theme', light ? 'light' : 'dark'); } catch (_) {}
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = light ? '#4c6457' : '#A3B8B0';
    Chart.defaults.borderColor = light ? 'rgba(35,90,58,.14)' : 'rgba(255,255,255,.07)';
  }
  if (typeof activeCharts !== 'undefined') {
    Object.values(activeCharts).forEach(chart => {
      if (!chart) return;
      try {
        chart.options.color = light ? '#4c6457' : '#A3B8B0';
        const scales = chart.options.scales || {};
        Object.values(scales).forEach(scale => {
          if (scale.ticks) scale.ticks.color = light ? '#526d5b' : '#A3B8B0';
          if (scale.grid && chart.canvas?.id !== 'chartEvolucaoClassicos') scale.grid.color = light ? 'rgba(35,90,58,.12)' : 'rgba(255,255,255,.07)';
        });
        if (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
          chart.options.plugins.legend.labels.color = light ? '#334f3d' : '#A3B8B0';
        }
        chart.update('none');
      } catch (error) { console.warn('Falha ao atualizar tema do gráfico:', error); }
    });
  }
  // V3.2.54: rebuild the classics saldo datasets on theme changes.
  if (lastClassicosSaldoData && document.getElementById('chartEvolucaoClassicos')) {
    updateClassicosChart(lastClassicosSaldoData);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  applyDashboardTheme(savedTheme);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyDashboardTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
});

// V3.2.40 — Base independente de confrontos entre rivais.
const RIVALS_DATA = {"fv":{"a":"Flamengo","b":"Vasco","rows":[["29-abr.-23",1923,1,3,"Campeonato Carioca","","Vasco"],["8-jul.-23",1923,3,2,"Campeonato Carioca","","Flamengo"],["28-jun.-25",1925,2,0,"Campeonato Carioca","","Flamengo"],["15-nov.-25",1925,1,1,"Campeonato Carioca","",""],["13-jun.-26",1926,2,2,"Campeonato Carioca","",""],["24-jun.-26",1926,2,1,"Amistoso","","Flamengo"],["11-jul.-26",1926,3,3,"Amistoso","",""],["12-set.-26",1926,1,2,"Campeonato Carioca","","Vasco"],["15-mai.-27",1927,1,3,"Amistoso","","Vasco"],["19-jun.-27",1927,3,0,"Campeonato Carioca","","Flamengo"],["4-set.-27",1927,2,1,"Campeonato Carioca","","Flamengo"],["3-mai.-28",1928,2,3,"Amistoso","","Vasco"],["3-jun.-28",1928,0,3,"Campeonato Carioca","","Vasco"],["30-set.-28",1928,1,2,"Campeonato Carioca","","Vasco"],["10-mar.-29",1929,1,4,"Amistoso","","Vasco"],["16-mai.-29",1929,2,1,"Amistoso","","Flamengo"],["14-jul.-29",1929,2,3,"Campeonato Carioca","","Vasco"],["27-out.-29",1929,0,1,"Campeonato Carioca","","Vasco"],["14-set.-30",1930,0,2,"Campeonato Carioca","","Vasco"],["7-dez.-30",1930,1,2,"Campeonato Carioca","","Vasco"],["26-abr.-31",1931,0,7,"Campeonato Carioca","Maior goleada do Vasco sobre o Flamengo.","Vasco"],["18-out.-31",1931,1,2,"Campeonato Carioca","","Vasco"],["17-jul.-32",1932,2,1,"Campeonato Carioca","","Flamengo"],["16-out.-32",1932,1,0,"Campeonato Carioca","","Flamengo"],["25-jun.-33",1933,2,1,"Campeonato Carioca / Torneio Rio-São Paulo","","Flamengo"],["1-out.-33",1933,0,2,"Campeonato Carioca / Torneio Rio-São Paulo","","Vasco"],["1-mai.-34",1934,2,5,"Campeonato Carioca","","Vasco"],["22-jul.-34",1934,3,2,"Campeonato Carioca","","Flamengo"],["7-out.-34",1934,4,1,"Torneio Extra de Profissionais","","Flamengo"],["25-nov.-34",1934,3,0,"Torneio Extra de Profissionais","O Vasco não compareceu por ter se afastado da Liga Carioca de Futebol. O Flamengo ganhou os pontos para efeito de classificação. Não computado para efeito de estatística.","Flamengo"],["15-ago.-37",1937,2,2,"Amistoso","",""],["22-ago.-37",1937,2,3,"Amistoso","","Vasco"],["10-out.-37",1937,3,3,"Campeonato Carioca","",""],["19-jan.-38",1938,5,1,"Campeonato Carioca","","Flamengo"],["12-fev.-38",1938,5,2,"Amistoso","","Flamengo"],["22-mai.-38",1938,3,5,"Torneio Municipal","","Vasco"],["24-jul.-38",1938,3,1,"Torneio Municipal","","Flamengo"],["4-set.-38",1938,0,2,"Campeonato Carioca","","Vasco"],["13-nov.-38",1938,1,2,"Campeonato Carioca","","Vasco"],["17-mar.-39",1939,6,4,"Amistoso","","Flamengo"],["11-jun.-39",1939,0,2,"Campeonato Carioca","","Vasco"],["3-set.-39",1939,3,0,"Campeonato Carioca","","Flamengo"],["3-dez.-39",1939,4,0,"Campeonato Carioca","","Flamengo"],["30-jun.-40",1940,2,3,"Campeonato Carioca","","Vasco"],["15-set.-40",1940,3,0,"Campeonato Carioca / Torneio Rio-São Paulo","","Flamengo"],["8-dez.-40",1940,1,1,"Campeonato Carioca","",""],["24-abr.-41",1941,1,3,"Amistoso","","Vasco"],["1-jun.-41",1941,3,1,"Campeonato Carioca","","Flamengo"],["3-ago.-41",1941,2,1,"Campeonato Carioca","","Flamengo"],["5-out.-41",1941,1,0,"Campeonato Carioca","","Flamengo"],["9-nov.-41",1941,1,1,"Campeonato Carioca","",""],["26-abr.-42",1942,1,1,"Campeonato Carioca","",""],["28-jun.-42",1942,1,0,"Campeonato Carioca","","Flamengo"],["30-ago.-42",1942,2,1,"Campeonato Carioca","","Flamengo"],["16-mar.-43",1943,1,1,"Torneio Relâmpago","",""],["29-mai.-43",1943,2,0,"Torneio Municipal","","Flamengo"],["31-jul.-43",1943,1,1,"Campeonato Carioca","",""],["3-out.-43",1943,6,2,"Campeonato Carioca","Maior goleada do Flamengo sobre o Vasco.","Flamengo"],["19-mar.-44",1944,2,5,"Torneio Relâmpago","","Vasco"],["24-jun.-44",1944,2,2,"Torneio Municipal","",""],["26-ago.-44",1944,1,2,"Campeonato Carioca","","Vasco"],["29-out.-44",1944,1,0,"Campeonato Carioca","Decisão.","Flamengo"],["8-abr.-45",1945,4,3,"Torneio Relâmpago","","Flamengo"],["13-mai.-45",1945,1,5,"Torneio Municipal","","Vasco"],["16-set.-45",1945,1,2,"Campeonato Carioca","","Vasco"],["18-nov.-45",1945,2,2,"Campeonato Carioca","Jogo interrompido aos 26 minutos do 2o. tempo com o placar de 2x2, devido a uma briga generalizada, e terminado no dia 20 de novembro nas Laranjeiras, sem alteração no placar.",""],["24-mar.-46",1946,0,2,"Torneio Relâmpago","","Vasco"],["19-mai.-46",1946,1,3,"Torneio Municipal","","Vasco"],["3-ago.-46",1946,2,2,"Campeonato Carioca","",""],["6-out.-46",1946,3,4,"Campeonato Carioca","","Vasco"],["25-mai.-47",1947,2,2,"Torneio Municipal","",""],["19-jul.-47",1947,1,2,"Amistoso","","Vasco"],["14-set.-47",1947,1,2,"Campeonato Carioca","","Vasco"],["30-nov.-47",1947,2,5,"Campeonato Carioca","","Vasco"],["30-mai.-48",1948,1,2,"Torneio Municipal","","Vasco"],["1-ago.-48",1948,1,3,"Campeonato Carioca","","Vasco"],["24-out.-48",1948,2,3,"Campeonato Carioca","","Vasco"],["21-ago.-49",1949,2,5,"Campeonato Carioca","","Vasco"],["13-nov.-49",1949,1,2,"Campeonato Carioca","","Vasco"],["14-jan.-50",1950,1,1,"Torneio Rio-São Paulo","",""],["24-set.-50",1950,1,2,"Campeonato Carioca","","Vasco"],["26-nov.-50",1950,1,4,"Campeonato Carioca","","Vasco"],["25-mar.-51",1951,2,2,"Torneio Rio-São Paulo","",""],["6-mai.-51",1951,2,1,"Torneio Municipal","","Flamengo"],["16-set.-51",1951,2,1,"Campeonato Carioca","","Flamengo"],["22-dez.-51",1951,2,0,"Campeonato Carioca","","Flamengo"],["20-fev.-52",1952,0,1,"Torneio Rio-São Paulo","","Vasco"],["28-set.-52",1952,2,3,"Campeonato Carioca","","Vasco"],["14-dez.-52",1952,0,1,"Campeonato Carioca","","Vasco"],["3-fev.-53",1953,2,5,"Torneio Quadrangular Internacional do Rio","","Vasco"],["26-abr.-53",1953,1,1,"Torneio Rio-São Paulo","",""],["20-set.-53",1953,3,3,"Campeonato Carioca","",""],["25-out.-53",1953,3,3,"Campeonato Carioca","",""],["10-jan.-54",1954,4,1,"Campeonato Carioca","","Flamengo"],["26-mai.-54",1954,4,1,"Torneio Rio-São Paulo","","Flamengo"],["17-out.-54",1954,2,1,"Campeonato Carioca","","Flamengo"],["9-jan.-55",1955,0,0,"Campeonato Carioca","",""],["12-fev.-55",1955,2,1,"Campeonato Carioca","","Flamengo"],["7-mai.-55",1955,2,1,"Torneio Rio-São Paulo","","Flamengo"],["16-jul.-55",1955,3,3,"Amistoso","",""],["2-out.-55",1955,0,3,"Campeonato Carioca","","Vasco"],["22-jan.-56",1956,1,1,"Campeonato Carioca","",""],["18-mar.-56",1956,1,2,"Campeonato Carioca","","Vasco"],["7-out.-56",1956,1,1,"Campeonato Carioca","",""],["4-nov.-56",1956,1,0,"Campeonato Carioca","","Flamengo"],["8-mai.-57",1957,0,1,"Torneio Rio-São Paulo","","Vasco"],["6-out.-57",1957,4,1,"Campeonato Carioca","","Flamengo"],["15-dez.-57",1957,4,1,"Campeonato Carioca","","Flamengo"],["29-mar.-58",1958,1,1,"Torneio Rio-São Paulo","",""],["14-set.-58",1958,1,1,"Campeonato Carioca","",""],["14-dez.-58",1958,3,1,"Campeonato Carioca","","Flamengo"],["20-dez.-58",1958,0,2,"Campeonato Carioca","","Vasco"],["17-jan.-59",1959,1,1,"Campeonato Carioca","Decisão do super-supercampeonato. O empate deu o título de 1958 ao Vasco.",""],["1-mar.-59",1959,2,2,"Taça Cidade do Rio de Janeiro","",""],["26-abr.-59",1959,0,0,"Torneio Rio-São Paulo","",""],["12-jul.-59",1959,2,2,"Campeonato Carioca","",""],["12-dez.-59",1959,1,1,"Campeonato Carioca","",""],["10-abr.-60",1960,1,0,"Torneio Rio-São Paulo","","Flamengo"],["4-set.-60",1960,0,1,"Campeonato Carioca","","Vasco"],["26-nov.-60",1960,0,1,"Campeonato Carioca","","Vasco"],["10-jan.-61",1961,0,1,"Torneio Octogonal Internacional de Verão","","Vasco"],["2-abr.-61",1961,2,1,"Torneio Rio-São Paulo","","Flamengo"],["2-ago.-61",1961,1,0,"Campeonato Carioca","","Flamengo"],["14-out.-61",1961,3,0,"Campeonato Carioca","","Flamengo"],["13-dez.-61",1961,0,2,"Campeonato Carioca","","Vasco"],["25-fev.-62",1962,1,1,"Torneio Rio-São Paulo","",""],["16-set.-62",1962,2,0,"Campeonato Carioca","","Flamengo"],["9-dez.-62",1962,1,1,"Campeonato Carioca","",""],["21-fev.-63",1963,3,1,"Torneio Rio-São Paulo","","Flamengo"],["24-ago.-63",1963,0,0,"Campeonato Carioca","",""],["15-nov.-63",1963,4,3,"Campeonato Carioca","","Flamengo"],["21-mar.-64",1964,3,1,"Torneio Rio-São Paulo","","Flamengo"],["27-ago.-64",1964,2,1,"Campeonato Carioca","","Flamengo"],["22-nov.-64",1964,2,1,"Campeonato Carioca","","Flamengo"],["21-jan.-65",1965,1,4,"Torneio IV Centenário","","Vasco"],["31-jan.-65",1965,0,0,"Torneio Gilberto Alves","",""],["10-abr.-65",1965,0,0,"Torneio Rio-São Paulo","",""],["5-mai.-65",1965,0,1,"Torneio Rio-São Paulo","","Vasco"],["22-jul.-65",1965,1,1,"Taça Guanabara","",""],["25-ago.-65",1965,0,1,"Taça Guanabara","","Vasco"],["9-out.-65",1965,2,1,"Campeonato Carioca","","Flamengo"],["28-nov.-65",1965,1,0,"Campeonato Carioca","","Flamengo"],["17-mar.-66",1966,1,1,"Torneio Rio-São Paulo","",""],["31-mar.-66",1966,1,2,"Amistoso","","Vasco"],["14-ago.-66",1966,1,0,"Taça Guanabara","","Flamengo"],["8-out.-66",1966,0,0,"Campeonato Carioca","",""],["6-nov.-66",1966,2,1,"Amistoso","","Flamengo"],["19-nov.-66",1966,2,0,"Campeonato Carioca","","Flamengo"],["15-jan.-67",1967,2,0,"Taça Rivadávia Correia Meyer","","Flamengo"],["19-jan.-67",1967,0,2,"Taça Rivadávia Correia Meyer","","Vasco"],["22-abr.-67",1967,0,0,"Torneio Roberto Gomes Pedrosa","",""],["10-mai.-67",1967,1,2,"Amistoso","","Vasco"],["22-jul.-67",1967,3,4,"Taça Guanabara","","Vasco"],["11-nov.-67",1967,0,4,"Campeonato Carioca","","Vasco"],["2-dez.-67",1967,0,3,"Campeonato Carioca","","Vasco"],["1-mai.-68",1968,2,1,"Campeonato Carioca","","Flamengo"],["30-mai.-68",1968,2,2,"Campeonato Carioca","",""],["18-ago.-68",1968,1,0,"Taça Guanabara","","Flamengo"],["30-nov.-68",1968,0,2,"Taça de Prata","","Vasco"],["11-mai.-69",1969,3,0,"Campeonato Carioca","","Flamengo"],["8-jun.-69",1969,1,1,"Campeonato Carioca","",""],["5-ago.-69",1969,2,1,"Taça Guanabara","","Flamengo"],["31-ago.-69",1969,2,0,"Amistoso","","Flamengo"],["5-out.-69",1969,3,1,"Taça de Prata","","Flamengo"],["22-fev.-70",1970,2,0,"Torneio Internacional de Verão do Rio","","Flamengo"],["1-mai.-70",1970,0,0,"Taça Guanabara","",""],["10-mai.-70",1970,2,0,"Taça Guanabara","","Flamengo"],["9-ago.-70",1970,0,1,"Campeonato Carioca","","Vasco"],["30-ago.-70",1970,0,1,"Campeonato Carioca","","Vasco"],["4-out.-70",1970,3,1,"Taça de Prata","","Flamengo"],["17-jan.-71",1971,2,1,"Amistoso","","Flamengo"],["21-abr.-71",1971,0,1,"Campeonato Carioca","","Vasco"],["9-jun.-71",1971,1,0,"Campeonato Carioca","","Flamengo"],["29-jul.-71",1971,2,1,"Taça Guanabara","","Flamengo"],["3-out.-71",1971,0,0,"Campeonato Brasileiro","",""],["20-jan.-72",1972,1,0,"Torneio Inter. de Verão do Rio","","Flamengo"],["16-abr.-72",1972,1,0,"Campeonato Carioca","","Flamengo"],["7-mai.-72",1972,2,2,"Campeonato Carioca","",""],["20-ago.-72",1972,0,0,"Campeonato Carioca","",""],["31-ago.-72",1972,1,0,"Campeonato Carioca","","Flamengo"],["8-out.-72",1972,2,1,"Campeonato Brasileiro","","Flamengo"],["10-dez.-72",1972,1,1,"Campeonato Brasileiro","",""],["21-jan.-73",1973,1,0,"Taça Cidade do Rio de Janeiro","","Flamengo"],["10-fev.-73",1973,0,1,"Torneio Erasmo Martins Pedro","","Vasco"],["6-mai.-73",1973,1,0,"Campeonato Carioca","","Flamengo"],["10-jun.-73",1973,2,1,"Taça Araribóia","","Flamengo"],["22-jul.-73",1973,1,2,"Campeonato Carioca","","Vasco"],["19-ago.-73",1973,0,0,"Campeonato Carioca","",""],["23-set.-73",1973,2,2,"Campeonato Brasileiro","",""],["25-nov.-73",1973,2,0,"Campeonato Brasileiro","","Flamengo"],["17-mar.-74",1974,1,1,"Campeonato Brasileiro","",""],["21-set.-74",1974,1,0,"Campeonato Carioca","","Flamengo"],["20-out.-74",1974,1,1,"Campeonato Carioca","",""],["24-nov.-74",1974,3,1,"Campeonato Carioca","","Flamengo"],["22-dez.-74",1974,0,0,"Campeonato Carioca","Decisão. O empate deu o título ao Flamengo.",""],["8-fev.-75",1975,1,2,"Amistoso","","Vasco"],["2-mar.-75",1975,2,2,"Campeonato Carioca","",""],["8-jun.-75",1975,2,1,"Campeonato Carioca","","Flamengo"],["13-jul.-75",1975,2,3,"Campeonato Carioca","","Vasco"],["7-ago.-75",1975,0,1,"Campeonato Carioca","","Vasco"],["7-set.-75",1975,2,4,"Campeonato Brasileiro","","Vasco"],["4-abr.-76",1976,3,1,"Campeonato Estadual","","Flamengo"],["13-jun.-76",1976,1,1,"Campeonato Estadual","O Vasco venceu por 5x4 nos pênaltis e conquistou o primeiro turno (Taça Guanabara).",""],["27-jun.-76",1976,4,1,"Campeonato Estadual","","Flamengo"],["15-ago.-76",1976,2,0,"Campeonato Estadual","","Flamengo"],["21-nov.-76",1976,0,1,"Campeonato Brasileiro","","Vasco"],["3-dez.-76",1976,2,3,"Torneio Quadrangular Heleno Nunes","","Vasco"],["13-fev.-77",1977,1,2,"Amistoso","","Vasco"],["20-mar.-77",1977,2,1,"Amistoso","","Flamengo"],["24-abr.-77",1977,0,3,"Campeonato Estadual","","Vasco"],["7-ago.-77",1977,0,0,"Campeonato Estadual","",""],["28-set.-77",1977,0,0,"Campeonato Estadual","O Vasco venceu por 5x4 nos pênaltis e conquistou o segundo turno e consequentemente o campeonato, pois já havia conquistado também o primeiro turno.",""],["29-jan.-78",1978,0,0,"Campeonato Brasileiro","",""],["17-set.-78",1978,0,0,"Campeonato Estadual","",""],["3-dez.-78",1978,1,0,"Campeonato Estadual","Com esta vitória, o Flamengo conquistou o segundo turno e consequentemente o campeonato, pois já havia vencido também o primeiro turno.","Flamengo"],["4-mar.-79",1979,1,1,"Campeonato Estadual Especial","",""],["15-abr.-79",1979,2,1,"Campeonato Estadual Especial","","Flamengo"],["22-jul.-79",1979,4,2,"Campeonato Estadual","","Flamengo"],["9-set.-79",1979,2,4,"Campeonato Estadual","","Vasco"],["28-out.-79",1979,3,2,"Campeonato Estadual","","Flamengo"],["3-fev.-80",1980,0,1,"Torneio José Fernandes","","Vasco"],["3-ago.-80",1980,0,0,"Taça Guanabara","",""],["19-out.-80",1980,0,0,"Campeonato Estadual","",""],["16-nov.-80",1980,2,0,"Campeonato Estadual","","Flamengo"],["17-mai.-81",1981,0,1,"Torneio João Havelange","","Vasco"],["7-jun.-81",1981,1,0,"Campeonato Estadual","","Flamengo"],["20-set.-81",1981,1,1,"Campeonato Estadual","",""],["29-nov.-81",1981,0,2,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["2-dez.-81",1981,0,1,"Campeonato Estadual","Decisão, segundo jogo.","Vasco"],["6-dez.-81",1981,2,1,"Campeonato Estadual","Decisão, terceiro jogo.","Flamengo"],["19-set.-82",1982,0,0,"Campeonato Estadual","",""],["23-set.-82",1982,1,0,"Campeonato Estadual","","Flamengo"],["20-nov.-82",1982,1,3,"Campeonato Estadual","","Vasco"],["5-dez.-82",1982,0,1,"Campeonato Estadual","Decisão.","Vasco"],["5-mai.-83",1983,2,1,"Campeonato Brasileiro","","Flamengo"],["8-mai.-83",1983,1,1,"Campeonato Brasileiro","",""],["5-out.-83",1983,0,1,"Campeonato Estadual","","Vasco"],["27-nov.-83",1983,3,0,"Campeonato Estadual","","Flamengo"],["5-ago.-84",1984,0,1,"Campeonato Estadual","","Vasco"],["4-nov.-84",1984,1,1,"Campeonato Estadual","",""],["12-dez.-84",1984,1,0,"Campeonato Estadual","","Flamengo"],["10-out.-85",1985,0,4,"Campeonato Estadual","","Vasco"],["30-nov.-85",1985,2,0,"Campeonato Estadual","","Flamengo"],["20-abr.-86",1986,0,2,"Campeonato Estadual","","Vasco"],["22-jun.-86",1986,1,2,"Amistoso","","Vasco"],["27-jul.-86",1986,3,2,"Campeonato Estadual","","Flamengo"],["3-ago.-86",1986,0,0,"Campeonato Estadual","",""],["6-ago.-86",1986,0,0,"Campeonato Estadual","Decisão, primeiro jogo.",""],["10-ago.-86",1986,2,0,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["19-abr.-87",1987,0,0,"Campeonato Estadual","",""],["17-mai.-87",1987,0,0,"Campeonato Estadual","",""],["19-jul.-87",1987,0,0,"Campeonato Estadual","",""],["9-ago.-87",1987,0,1,"Campeonato Estadual","Decisão.","Vasco"],["20-set.-87",1987,2,1,"Campeonato Brasileiro","","Flamengo"],["31-jan.-88",1988,1,0,"Campeonato Estadual","","Flamengo"],["8-mai.-88",1988,0,1,"Campeonato Estadual","","Vasco"],["12-jun.-88",1988,1,3,"Campeonato Estadual","","Vasco"],["19-jun.-88",1988,1,2,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["22-jun.-88",1988,0,1,"Campeonato Estadual","Decisão, segundo jogo.","Vasco"],["4-set.-88",1988,0,1,"Campeonato Brasileiro","","Vasco"],["23-abr.-89",1989,3,1,"Campeonato Estadual","","Flamengo"],["12-jun.-89",1989,1,2,"Campeonato Estadual","","Vasco"],["5-nov.-89",1989,2,0,"Campeonato Brasileiro","","Flamengo"],["4-mar.-90",1990,1,1,"Campeonato Estadual","",""],["15-abr.-90",1990,1,2,"Campeonato Estadual","","Vasco"],["16-set.-90",1990,1,0,"Campeonato Brasileiro","","Flamengo"],["24-mar.-91",1991,3,0,"Campeonato Brasileiro","","Flamengo"],["30-jun.-91",1991,2,0,"Copa Rio de Janeiro","","Flamengo"],["15-set.-91",1991,2,1,"Campeonato Estadual","","Flamengo"],["24-nov.-91",1991,2,0,"Campeonato Estadual","","Flamengo"],["29-mar.-92",1992,2,4,"Campeonato Brasileiro","","Vasco"],["28-jun.-92",1992,1,1,"Campeonato Brasileiro","",""],["1-jul.-92",1992,2,0,"Campeonato Brasileiro","","Flamengo"],["15-jul.-92",1992,1,2,"Copa Rio de Janeiro","","Vasco"],["4-out.-92",1992,1,1,"Campeonato Estadual","",""],["6-dez.-92",1992,1,1,"Campeonato Estadual","Com este empate, o Vasco conquistou o segundo turno e consequentemente o campeonato, pois já havia vencido também o primeiro turno.",""],["11-abr.-93",1993,1,2,"Campeonato Estadual","","Vasco"],["23-mai.-93",1993,0,1,"Campeonato Estadual","","Vasco"],["28-out.-93",1993,1,0,"Copa Rio de Janeiro","","Flamengo"],["25-nov.-93",1993,0,2,"Copa Rio de Janeiro","","Vasco"],["29-nov.-93",1993,0,1,"Copa Rio de Janeiro","","Vasco"],["27-fev.-94",1994,1,3,"Campeonato Estadual","","Vasco"],["24-abr.-94",1994,2,1,"Campeonato Estadual","","Flamengo"],["1-mai.-94",1994,1,1,"Campeonato Estadual","",""],["29-mai.-94",1994,1,0,"Amistoso","","Flamengo"],["13-nov.-94",1994,1,1,"Campeonato Brasileiro","",""],["7-mai.-95",1995,1,0,"Campeonato Estadual","","Flamengo"],["28-mai.-95",1995,4,2,"Campeonato Estadual","","Flamengo"],["29-out.-95",1995,1,1,"Campeonato Brasileiro","",""],["28-jan.-96",1996,0,0,"Taça Cidade Maravilhosa","",""],["5-mai.-96",1996,2,0,"Campeonato Estadual","","Flamengo"],["30-jun.-96",1996,0,0,"Campeonato Estadual","Com este empate, o Flamengo conquistou o segundo turno e consequentemente o campeonato, pois já havia vencido também o primeiro turno.",""],["20-jul.-96",1996,2,3,"Amistoso","","Vasco"],["6-out.-96",1996,1,4,"Campeonato Brasileiro","","Vasco"],["23-mar.-97",1997,3,1,"Campeonato Estadual","","Flamengo"],["3-mai.-97",1997,2,1,"Campeonato Estadual","","Flamengo"],["3-jul.-97",1997,0,3,"Campeonato Estadual","Jogo não realizado pelo Flamengo ter abandonado a competição no terceiro turno. O Vasco ganhou os pontos para efeito de classificação. Não computado para efeito de estatística.","Vasco"],["27-jul.-97",1997,0,1,"Campeonato Brasileiro","","Vasco"],["23-nov.-97",1997,1,1,"Campeonato Brasileiro","",""],["3-dez.-97",1997,1,4,"Campeonato Brasileiro","","Vasco"],["19-abr.-98",1998,0,0,"Campeonato Estadual","",""],["17-mai.-98",1998,0,3,"Campeonato Estadual","O Flamengo não compareceu para o jogo e o Vasco ganhou os pontos para efeito de classificação. Não computado para efeito de estatística.","Vasco"],["30-ago.-98",1998,1,1,"Campeonato Brasileiro","",""],["18-abr.-99",1999,2,1,"Campeonato Estadual","","Flamengo"],["6-jun.-99",1999,0,2,"Campeonato Estadual","","Vasco"],["13-jun.-99",1999,1,1,"Campeonato Estadual","Decisão, primeiro jogo.",""],["20-jun.-99",1999,1,0,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["3-out.-99",1999,0,1,"Campeonato Brasileiro","","Vasco"],["23-abr.-00",2000,1,5,"Campeonato Estadual","","Vasco"],["28-mai.-00",2000,3,3,"Campeonato Estadual","",""],["11-jun.-00",2000,3,0,"Campeonato Estadual","Decisão, primeiro jogo.","Flamengo"],["17-jun.-00",2000,2,1,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["27-out.-00",2000,4,0,"Campeonato Brasileiro","","Flamengo"],["22-fev.-01",2001,1,0,"Campeonato Estadual","","Flamengo"],["13-mai.-01",2001,0,0,"Campeonato Estadual","",""],["20-mai.-01",2001,1,2,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["27-mai.-01",2001,3,1,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["6-out.-01",2001,1,5,"Campeonato Brasileiro","","Vasco"],["10-mar.-02",2002,1,3,"Torneio Rio-São Paulo","","Vasco"],["25-mar.-02",2002,0,1,"Campeonato Estadual","","Vasco"],["26-mai.-02",2002,0,0,"Campeonato Estadual","",""],["16-out.-02",2002,1,2,"Campeonato Brasileiro","","Vasco"],["1-mar.-03",2003,1,1,"Campeonato Estadual","",""],["15-jun.-03",2003,2,1,"Campeonato Brasileiro","","Flamengo"],["12-out.-03",2003,2,1,"Campeonato Brasileiro","","Flamengo"],["15-fev.-04",2004,2,0,"Campeonato Estadual","","Flamengo"],["21-mar.-04",2004,1,2,"Campeonato Estadual","","Vasco"],["11-abr.-04",2004,2,1,"Campeonato Estadual","Decisão, primeiro jogo.","Flamengo"],["18-abr.-04",2004,3,1,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["10-jul.-04",2004,0,1,"Campeonato Brasileiro","","Vasco"],["25-out.-04",2004,0,1,"Campeonato Brasileiro","","Vasco"],["20-mar.-05",2005,2,2,"Campeonato Estadual","",""],["17-jul.-05",2005,1,0,"Campeonato Brasileiro","","Flamengo"],["22-out.-05",2005,1,2,"Campeonato Brasileiro","","Vasco"],["19-mar.-06",2006,1,2,"Campeonato Estadual","","Vasco"],["16-jul.-06",2006,0,1,"Campeonato Brasileiro","","Vasco"],["19-jul.-06",2006,2,0,"Copa do Brasil","Decisão, primeiro jogo.","Flamengo"],["26-jul.-06",2006,1,0,"Copa do Brasil","Decisão, segundo jogo.","Flamengo"],["26-out.-06",2006,1,3,"Campeonato Brasileiro","","Vasco"],["25-fev.-07",2007,1,1,"Campeonato Estadual","Flamengo 3x1 nos pênaltis, classificado para a final do primeiro turno (Taça Guanabara).",""],["25-mar.-07",2007,0,3,"Campeonato Estadual","","Vasco"],["16-set.-07",2007,1,1,"Campeonato Brasileiro","",""],["18-out.-07",2007,2,1,"Campeonato Brasileiro","","Flamengo"],["17-fev.-08",2008,2,1,"Campeonato Estadual","","Flamengo"],["6-abr.-08",2008,2,2,"Campeonato Estadual","",""],["13-jul.-08",2008,3,1,"Campeonato Brasileiro","","Flamengo"],["19-out.-08",2008,1,0,"Campeonato Brasileiro","","Flamengo"],["22-mar.-09",2009,0,2,"Campeonato Estadual","","Vasco"],["14-mar.-10",2010,1,0,"Campeonato Estadual","","Flamengo"],["11-abr.-10",2010,2,1,"Campeonato Estadual","","Flamengo"],["1-ago.-10",2010,0,0,"Campeonato Brasileiro","",""],["24-out.-10",2010,1,1,"Campeonato Brasileiro","",""],["30-jan.-11",2011,2,1,"Campeonato Estadual","","Flamengo"],["1-mai.-11",2011,0,0,"Campeonato Estadual","O Flamengo venceu por 3x1 nos pênaltis e conquistou o segundo turno (Taça Rio) e consequentemente o campeonato, pois já havia vencido também o primeiro turno.",""],["28-ago.-11",2011,0,0,"Campeonato Brasileiro","",""],["4-dez.-11",2011,1,1,"Campeonato Brasileiro","",""],["22-fev.-12",2012,1,2,"Campeonato Estadual","","Vasco"],["7-abr.-12",2012,2,1,"Campeonato Estadual","","Flamengo"],["22-abr.-12",2012,2,3,"Campeonato Estadual","","Vasco"],["19-ago.-12",2012,1,0,"Campeonato Brasileiro","","Flamengo"],["24-nov.-12",2012,1,1,"Campeonato Brasileiro","",""],["31-jan.-13",2013,4,2,"Campeonato Estadual","","Flamengo"],["14-jul.-13",2013,1,0,"Campeonato Brasileiro","","Flamengo"],["6-out.-13",2013,1,1,"Campeonato Brasileiro","",""],["16-fev.-14",2014,2,1,"Campeonato Estadual","","Flamengo"],["6-abr.-14",2014,1,1,"Campeonato Estadual","Decisão, primeiro jogo",""],["13-abr.-14",2014,1,1,"Campeonato Estadual","Decisão, segundo jogo. Os dois empates deram o título ao Flamengo, por este ter feito mais pontos na primeira fase.",""],["21-jan.-15",2015,1,0,"Torneio de Manaus (Super Series)","","Flamengo"],["22-mar.-15",2015,2,1,"Campeonato Estadual","","Flamengo"],["12-abr.-15",2015,0,0,"Campeonato Estadual","",""],["19-abr.-15",2015,0,1,"Campeonato Estadual","","Vasco"],["28-jun.-15",2015,0,1,"Campeonato Brasileiro","","Vasco"],["19-ago.-15",2015,0,1,"Copa do Brasil","","Vasco"],["26-ago.-15",2015,1,1,"Copa do Brasil","",""],["27-set.-15",2015,1,2,"Campeonato Brasileiro","","Vasco"],["14-fev.-16",2016,0,1,"Campeonato Estadual","","Vasco"],["30-mar.-16",2016,1,1,"Campeonato Estadual","",""],["24-abr.-16",2016,0,2,"Campeonato Estadual","","Vasco"],["25-fev.-17",2017,1,0,"Campeonato Estadual","","Flamengo"],["26-mar.-17",2017,2,2,"Campeonato Estadual","",""],["8-abr.-17",2017,0,0,"Campeonato Estadual","",""],["8-jul.-17",2017,1,0,"Campeonato Brasileiro","","Flamengo"],["28-out.-17",2017,0,0,"Campeonato Brasileiro","",""],["27-jan.-18",2018,0,0,"Campeonato Estadual","",""],["19-mai.-18",2018,1,1,"Campeonato Brasileiro","",""],["15-set.-18",2018,1,1,"Campeonato Brasileiro","",""],["9-mar.-19",2019,1,1,"Campeonato Estadual","",""],["31-mar.-19",2019,1,1,"Campeonato Estadual","O Flamengo venceu por 3x1 nos pênaltis e conquistou o segundo turno (Taça Rio)",""],["14-abr.-19",2019,2,0,"Campeonato Estadual","Decisão, primeiro jogo","Flamengo"],["21-abr.-19",2019,2,0,"Campeonato Estadual","Decisão, segundo jogo","Flamengo"],["17-ago.-19",2019,4,1,"Campeonato Brasileiro","","Flamengo"],["13-nov.-19",2019,4,4,"Campeonato Brasileiro","",""],["22-jan.-20",2020,1,0,"Campeonato Estadual","","Flamengo"],["10-out.-20",2020,2,1,"Campeonato Brasileiro","","Flamengo"],["4-fev.-21",2021,2,0,"Campeonato Brasileiro","","Flamengo"],["15-abr.-21",2021,1,3,"Campeonato Estadual","","Vasco"],["6-mar.-22",2022,2,1,"Campeonato Estadual","","Flamengo"],["16-mar.-22",2022,1,0,"Campeonato Estadual","","Flamengo"],["20-mar.-22",2022,1,0,"Campeonato Estadual","","Flamengo"],["5-mar.-23",2023,0,1,"Campeonato Estadual","","Vasco"],["13-mar.-23",2023,3,2,"Campeonato Estadual","","Flamengo"],["19-mar.-23",2023,3,1,"Campeonato Estadual","","Flamengo"],["5-jun.-23",2023,4,1,"Campeonato Brasileiro","","Flamengo"],["22-out.-23",2023,1,0,"Campeonato Brasileiro","","Flamengo"],["4-fev.-24",2024,0,0,"Campeonato Estadual","",""],["2-jun.-24",2024,6,1,"Campeonato Brasileiro","","Flamengo"],["15-set.-24",2024,1,1,"Campeonato Brasileiro","",""],["15-fev.-25",2025,2,0,"Campeonato Estadual","","Flamengo"],["1-mar.-25",2025,1,0,"Campeonato Estadual","","Flamengo"],["8-mar.-25",2025,2,1,"Campeonato Estadual","","Flamengo"],["19-abr.-25",2025,0,0,"Campeonato Brasileiro","",""],["21-set.-25",2025,1,1,"Campeonato Brasileiro","",""],["21-jan.-26",2026,1,0,"Campeonato Estadual","","Flamengo"],["3-mai.-26",2026,2,2,"Campeonato Brasileiro","",""],["29-out.-26",2026,4,1,"Campeonato Brasileiro","","Flamengo"]]},"fb":{"a":"Flamengo","b":"Botafogo","rows":[["13-mai.-13",1913,0,1,"Campeonato Carioca","","Botafogo"],["16-out.-13",1913,0,0,"Campeonato Carioca","",""],["5-jul.-14",1914,2,2,"Campeonato Carioca","",""],["12-out.-14",1914,1,2,"Campeonato Carioca","","Botafogo"],["30-mai.-15",1915,2,1,"Campeonato Carioca","","Flamengo"],["19-set.-15",1915,0,0,"Campeonato Carioca","",""],["3-set.-16",1916,1,1,"Campeonato Carioca","",""],["29-out.-16",1916,3,3,"Campeonato Carioca","",""],["29-jun.-17",1917,5,0,"Campeonato Carioca","","Flamengo"],["25-nov.-17",1917,0,3,"Campeonato Carioca","","Botafogo"],["17-mar.-18",1918,5,1,"Amistoso","","Flamengo"],["13-mai.-18",1918,2,1,"Campeonato Carioca","","Flamengo"],["18-ago.-18",1918,0,3,"Campeonato Carioca","","Botafogo"],["8-jun.-19",1919,6,2,"Campeonato Carioca","","Flamengo"],["5-out.-19",1919,2,2,"Campeonato Carioca","",""],["11-jul.-20",1920,2,1,"Campeonato Carioca","","Flamengo"],["15-ago.-20",1920,3,1,"Campeonato Carioca","","Flamengo"],["5-jun.-21",1921,2,2,"Campeonato Carioca","",""],["21-ago.-21",1921,3,1,"Campeonato Carioca","","Flamengo"],["21-abr.-22",1922,0,0,"Campeonato Carioca","",""],["11-jun.-22",1922,2,2,"Campeonato Carioca","",""],["27-mai.-23",1923,4,1,"Campeonato Carioca","","Flamengo"],["5-ago.-23",1923,4,1,"Campeonato Carioca","","Flamengo"],["29-jun.-24",1924,0,5,"Campeonato Carioca","","Botafogo"],["12-out.-24",1924,3,0,"Campeonato Carioca","","Flamengo"],["31-mai.-25",1925,3,0,"Campeonato Carioca","","Flamengo"],["25-out.-25",1925,3,2,"Campeonato Carioca","","Flamengo"],["30-mai.-26",1926,3,5,"Campeonato Carioca","","Botafogo"],["15-ago.-26",1926,8,1,"Campeonato Carioca","Maior goleada do Flamengo.","Flamengo"],["29-mai.-27",1927,2,9,"Campeonato Carioca","Maior goleada do Botafogo.","Botafogo"],["7-ago.-27",1927,3,5,"Campeonato Carioca","","Botafogo"],["6-mai.-28",1928,3,1,"Campeonato Carioca","","Flamengo"],["5-jul.-28",1928,1,1,"Amistoso","",""],["13-ago.-28",1928,4,2,"Campeonato Carioca","","Flamengo"],["5-mai.-29",1929,4,2,"Campeonato Carioca","","Flamengo"],["18-ago.-29",1929,1,5,"Campeonato Carioca","","Botafogo"],["4-mai.-30",1930,1,2,"Campeonato Carioca","","Botafogo"],["19-out.-30",1930,0,2,"Campeonato Carioca","","Botafogo"],["12-abr.-31",1931,1,5,"Campeonato Carioca","","Botafogo"],["22-ago.-31",1931,2,1,"Amistoso","","Flamengo"],["4-out.-31",1931,3,1,"Campeonato Carioca","","Flamengo"],["13-mar.-32",1932,1,7,"Amistoso","","Botafogo"],["10-abr.-32",1932,0,3,"Torneio Preparatório","","Botafogo"],["22-mai.-32",1932,0,1,"Campeonato Carioca","","Botafogo"],["21-ago.-32",1932,2,2,"Campeonato Carioca","",""],["8-ago.-37",1937,2,2,"Amistoso","",""],["28-ago.-37",1937,3,2,"Amistoso","","Flamengo"],["7-nov.-37",1937,2,2,"Campeonato Carioca","",""],["12-dez.-37",1937,2,2,"Campeonato Carioca","",""],["1-mai.-38",1938,1,2,"Torneio Municipal","","Botafogo"],["3-jul.-38",1938,2,2,"Torneio Municipal","",""],["8-set.-38",1938,0,4,"Amistoso","","Botafogo"],["9-out.-38",1938,5,0,"Campeonato Carioca","","Flamengo"],["27-out.-38",1938,1,0,"Torneio Extra","","Flamengo"],["18-dez.-38",1938,2,0,"Campeonato Carioca","","Flamengo"],["16-abr.-39",1939,4,1,"Campeonato Carioca","","Flamengo"],["9-jul.-39",1939,1,5,"Campeonato Carioca","","Botafogo"],["8-out.-39",1939,2,3,"Campeonato Carioca","","Botafogo"],["5-mai.-40",1940,3,2,"Campeonato Carioca","","Flamengo"],["1-set.-40",1940,3,2,"Campeonato Carioca / Torneio Rio-São Paulo","","Flamengo"],["24-nov.-40",1940,1,1,"Campeonato Carioca","",""],["22-jun.-41",1941,1,3,"Campeonato Carioca","","Botafogo"],["24-ago.-41",1941,1,1,"Campeonato Carioca","",""],["28-set.-41",1941,1,2,"Campeonato Carioca","","Botafogo"],["2-nov.-41",1941,2,3,"Campeonato Carioca","","Botafogo"],["12-abr.-42",1942,1,1,"Campeonato Carioca","",""],["21-jun.-42",1942,2,2,"Campeonato Carioca","",""],["23-ago.-42",1942,4,0,"Campeonato Carioca","","Flamengo"],["19-mar.-43",1943,4,1,"Torneio Relâmpago","","Flamengo"],["18-abr.-43",1943,2,2,"Torneio Municipal","",""],["20-jun.-43",1943,4,1,"Campeonato Carioca","","Flamengo"],["22-ago.-43",1943,4,2,"Campeonato Carioca","","Flamengo"],["5-mar.-44",1944,2,6,"Torneio Relâmpago","","Botafogo"],["9-abr.-44",1944,2,4,"Torneio Municipal","","Botafogo"],["9-jul.-44",1944,4,1,"Campeonato Carioca","","Flamengo"],["10-set.-44",1944,2,5,"Campeonato Carioca","A partida foi encerrada aos 31 minutos do segundo tempo quando os jogadores do Flamengo se sentaram em campo, se recusando a continuar jogando. O resultado foi mantido.","Botafogo"],["28-mar.-45",1945,0,1,"Torneio Relâmpago","","Botafogo"],["23-jun.-45",1945,2,0,"Torneio Municipal","","Flamengo"],["26-ago.-45",1945,1,3,"Campeonato Carioca","","Botafogo"],["28-out.-45",1945,0,2,"Campeonato Carioca","","Botafogo"],["31-mar.-46",1946,1,1,"Torneio Relâmpago","",""],["2-jun.-46",1946,4,6,"Torneio Municipal","","Botafogo"],["18-ago.-46",1946,2,2,"Campeonato Carioca","",""],["26-out.-46",1946,3,2,"Campeonato Carioca","","Flamengo"],["23-nov.-46",1946,0,1,"Campeonato Carioca","","Botafogo"],["14-dez.-46",1946,1,2,"Campeonato Carioca","O Flamengo saiu de campo aos 11 minutos do segundo tempo, em protesto contra as expulsões de Perácio e Pirilo. O resultado foi mantido.","Botafogo"],["18-mai.-47",1947,1,0,"Torneio Municipal","","Flamengo"],["7-set.-47",1947,2,2,"Campeonato Carioca","",""],["23-nov.-47",1947,2,4,"Campeonato Carioca","","Botafogo"],["25-abr.-48",1948,2,0,"Torneio Municipal","","Flamengo"],["5-set.-48",1948,1,2,"Campeonato Carioca","","Botafogo"],["28-nov.-48",1948,3,5,"Campeonato Carioca","","Botafogo"],["1-mai.-49",1949,3,0,"Amistoso","","Flamengo"],["4-set.-49",1949,1,2,"Campeonato Carioca","","Botafogo"],["27-nov.-49",1949,2,1,"Campeonato Carioca","","Flamengo"],["11-fev.-50",1950,2,2,"Torneio Rio-São Paulo","",""],["5-ago.-50",1950,2,4,"Amistoso","","Botafogo"],["15-out.-50",1950,0,1,"Campeonato Carioca","","Botafogo"],["3-dez.-50",1950,2,4,"Campeonato Carioca","","Botafogo"],["26-abr.-51",1951,1,1,"Torneio Municipal","",""],["1-mai.-51",1951,1,1,"Amistoso","",""],["26-ago.-51",1951,1,2,"Campeonato Carioca","","Botafogo"],["5-jan.-52",1952,1,2,"Campeonato Carioca","","Botafogo"],["5-mar.-52",1952,2,2,"Torneio Rio-São Paulo","",""],["21-jun.-52",1952,2,0,"Torneio Extra Carlos Martins da Rocha","","Flamengo"],["13-set.-52",1952,3,2,"Campeonato Carioca","","Flamengo"],["10-jan.-53",1953,6,3,"Campeonato Carioca","","Flamengo"],["28-mar.-53",1953,3,0,"Torneio Internacional de Buenos Aires","","Flamengo"],["4-abr.-53",1953,3,3,"Torneio Rio-São Paulo","",""],["7-set.-53",1953,0,3,"Campeonato Carioca","","Botafogo"],["1-nov.-53",1953,1,1,"Campeonato Carioca","",""],["20-jan.-54",1954,1,0,"Campeonato Carioca","","Flamengo"],["23-mar.-54",1954,4,1,"Amistoso","","Flamengo"],["17-jun.-54",1954,1,2,"Torneio Rio-São Paulo","","Botafogo"],["7-nov.-54",1954,1,1,"Campeonato Carioca","",""],["11-dez.-54",1954,3,2,"Campeonato Carioca","","Flamengo"],["9-fev.-55",1955,2,0,"Campeonato Carioca","","Flamengo"],["5-mai.-55",1955,0,0,"Torneio Rio-São Paulo","",""],["4-set.-55",1955,1,0,"Campeonato Carioca","","Flamengo"],["4-fev.-56",1956,2,1,"Campeonato Carioca","","Flamengo"],["29-set.-56",1956,0,5,"Campeonato Carioca","","Botafogo"],["15-dez.-56",1956,0,1,"Campeonato Carioca","","Botafogo"],["22-mai.-57",1957,4,1,"Torneio Rio-São Paulo","","Flamengo"],["1-set.-57",1957,3,3,"Campeonato Carioca","",""],["17-nov.-57",1957,1,1,"Campeonato Carioca","",""],["20-mar.-58",1958,4,0,"Torneio Rio-São Paulo","","Flamengo"],["30-ago.-58",1958,2,2,"Campeonato Carioca","",""],["9-nov.-58",1958,2,3,"Campeonato Carioca","","Botafogo"],["27-dez.-58",1958,2,1,"Campeonato Carioca","","Flamengo"],["14-jan.-59",1959,2,2,"Campeonato Carioca","",""],["7-mai.-59",1959,3,2,"Torneio Rio-São Paulo","","Flamengo"],["3-out.-59",1959,1,2,"Campeonato Carioca","","Botafogo"],["25-out.-59",1959,6,2,"Campeonato Carioca","","Flamengo"],["24-mar.-60",1960,3,1,"Torneio Rio-São Paulo","","Flamengo"],["7-ago.-60",1960,0,0,"Campeonato Carioca","",""],["30-out.-60",1960,1,4,"Campeonato Carioca","","Botafogo"],["22-mar.-61",1961,0,3,"Torneio Rio-São Paulo","","Botafogo"],["1-mai.-61",1961,1,0,"Amistoso","","Flamengo"],["10-set.-61",1961,2,2,"Campeonato Carioca","",""],["25-nov.-61",1961,1,1,"Campeonato Carioca","",""],["28-dez.-61",1961,0,3,"Campeonato Carioca","","Botafogo"],["1-mar.-62",1962,3,2,"Torneio Rio-São Paulo","","Flamengo"],["14-mar.-62",1962,0,1,"Torneio Rio-São Paulo","","Botafogo"],["22-set.-62",1962,1,3,"Campeonato Carioca","","Botafogo"],["15-dez.-62",1962,0,3,"Campeonato Carioca","Decisão.","Botafogo"],["3-mar.-63",1963,1,2,"Torneio Rio-São Paulo","","Botafogo"],["21-jul.-63",1963,3,1,"Campeonato Carioca","","Flamengo"],["13-out.-63",1963,0,0,"Campeonato Carioca","",""],["11-abr.-64",1964,1,2,"Torneio Rio-São Paulo","","Botafogo"],["20-set.-64",1964,1,0,"Campeonato Carioca","","Flamengo"],["12-dez.-64",1964,0,1,"Campeonato Carioca","","Botafogo"],["17-abr.-65",1965,1,1,"Torneio Rio-São Paulo","",""],["8-mai.-65",1965,0,1,"Torneio Rio-São Paulo","","Botafogo"],["18-jul.-65",1965,1,2,"Taça Guanabara","","Botafogo"],["22-ago.-65",1965,0,1,"Taça Guanabara","","Botafogo"],["31-out.-65",1965,2,0,"Campeonato Carioca","","Flamengo"],["19-dez.-65",1965,0,1,"Campeonato Carioca","","Botafogo"],["2-mar.-66",1966,2,1,"Torneio Rio-São Paulo","","Flamengo"],["20-ago.-66",1966,0,0,"Taça Guanabara","",""],["15-out.-66",1966,0,0,"Campeonato Carioca","",""],["4-dez.-66",1966,1,1,"Campeonato Carioca","",""],["12-abr.-67",1967,4,2,"Torneio Roberto Gomes Pedrosa","","Flamengo"],["29-jul.-67",1967,0,1,"Taça Guanabara","","Botafogo"],["22-out.-67",1967,1,2,"Campeonato Carioca","","Botafogo"],["30-nov.-67",1967,0,1,"Campeonato Carioca","","Botafogo"],["14-abr.-68",1968,0,1,"Campeonato Carioca","","Botafogo"],["2-jun.-68",1968,0,1,"Campeonato Carioca","","Botafogo"],["8-set.-68",1968,0,0,"Taça Guanabara","",""],["18-set.-68",1968,1,4,"Taça Guanabara","Decisão.","Botafogo"],["19-out.-68",1968,0,0,"Taça de Prata","",""],["20-abr.-69",1969,0,2,"Campeonato Carioca","","Botafogo"],["1-jun.-69",1969,2,1,"Campeonato Carioca","","Flamengo"],["13-jul.-69",1969,1,1,"Taça Guanabara","",""],["17-ago.-69",1969,1,1,"Taça Guanabara","",""],["9-nov.-69",1969,1,3,"Taça de Prata","","Botafogo"],["7-mar.-70",1970,0,0,"Taça Guanabara","",""],["24-mai.-70",1970,2,1,"Taça Guanabara","","Flamengo"],["15-ago.-70",1970,1,1,"Campeonato Carioca","",""],["12-set.-70",1970,0,3,"Campeonato Carioca","","Botafogo"],["25-out.-70",1970,0,0,"Taça de Prata","",""],["14-mar.-71",1971,0,2,"Campeonato Carioca","","Botafogo"],["2-mai.-71",1971,1,1,"Campeonato Carioca","",""],["13-jun.-71",1971,2,0,"Campeonato Carioca","","Flamengo"],["10-jul.-71",1971,0,1,"Taça Guanabara","","Botafogo"],["14-ago.-71",1971,1,1,"Campeonato Brasileiro","",""],["8-jan.-72",1972,1,1,"Amistoso","",""],["26-mar.-72",1972,0,0,"Campeonato Carioca","",""],["16-jul.-72",1972,2,1,"Campeonato Carioca","","Flamengo"],["6-ago.-72",1972,2,1,"Campeonato Carioca","","Flamengo"],["15-nov.-72",1972,0,6,"Campeonato Brasileiro","","Botafogo"],["3-fev.-73",1973,1,1,"Torneio Erasmo Martins Pedro","",""],["15-abr.-73",1973,0,0,"Campeonato Carioca","",""],["20-mai.-73",1973,0,2,"Campeonato Carioca","","Botafogo"],["11-ago.-73",1973,0,2,"Campeonato Carioca","","Botafogo"],["8-dez.-73",1973,1,0,"Campeonato Brasileiro","","Flamengo"],["9-jun.-74",1974,2,0,"Campeonato Brasileiro","","Flamengo"],["15-set.-74",1974,2,2,"Campeonato Carioca","",""],["27-out.-74",1974,0,0,"Campeonato Carioca","",""],["17-nov.-74",1974,2,1,"Campeonato Carioca","","Flamengo"],["6-abr.-75",1975,0,1,"Campeonato Carioca","","Botafogo"],["25-mai.-75",1975,2,2,"Campeonato Carioca","",""],["19-jul.-75",1975,4,0,"Campeonato Carioca","","Flamengo"],["18-abr.-76",1976,1,0,"Campeonato Estadual","","Flamengo"],["11-jul.-76",1976,0,2,"Campeonato Estadual","","Botafogo"],["7-ago.-76",1976,2,1,"Campeonato Estadual","","Flamengo"],["17-abr.-77",1977,2,1,"Campeonato Estadual","","Flamengo"],["18-set.-77",1977,2,0,"Campeonato Estadual","","Flamengo"],["28-mai.-78",1978,1,1,"Campeonato Brasileiro","",""],["2-jul.-78",1978,1,1,"Campeonato Brasileiro","",""],["27-ago.-78",1978,2,0,"Torneio Cidade de Milão","","Flamengo"],["8-out.-78",1978,1,1,"Campeonato Estadual","",""],["19-nov.-78",1978,1,0,"Campeonato Estadual","","Flamengo"],["18-mar.-79",1979,3,0,"Campeonato Estadual Especial","","Flamengo"],["29-abr.-79",1979,2,2,"Campeonato Estadual Especial","",""],["3-jun.-79",1979,0,1,"Campeonato Estadual","","Botafogo"],["16-set.-79",1979,2,1,"Campeonato Estadual","","Flamengo"],["4-nov.-79",1979,0,0,"Campeonato Estadual","",""],["27-jul.-80",1980,1,1,"Taça Guanabara","",""],["12-out.-80",1980,1,1,"Campeonato Estadual","",""],["22-nov.-80",1980,3,1,"Campeonato Estadual","","Flamengo"],["16-abr.-81",1981,0,0,"Campeonato Brasileiro","",""],["19-abr.-81",1981,1,3,"Campeonato Brasileiro","","Botafogo"],["12-jul.-81",1981,0,0,"Campeonato Estadual","",""],["26-set.-81",1981,1,2,"Campeonato Estadual","","Botafogo"],["8-nov.-81",1981,6,0,"Campeonato Estadual","","Flamengo"],["14-ago.-82",1982,3,0,"Campeonato Estadual","","Flamengo"],["10-out.-82",1982,1,0,"Campeonato Estadual","","Flamengo"],["14-ago.-83",1983,0,3,"Campeonato Estadual","","Botafogo"],["30-out.-83",1983,1,0,"Campeonato Estadual","","Flamengo"],["15-jul.-84",1984,1,0,"Campeonato Estadual","","Flamengo"],["14-out.-84",1984,3,2,"Campeonato Estadual","","Flamengo"],["10-fev.-85",1985,1,2,"Campeonato Brasileiro","","Botafogo"],["24-mar.-85",1985,6,1,"Campeonato Brasileiro","","Flamengo"],["8-set.-85",1985,1,0,"Campeonato Estadual","","Flamengo"],["3-nov.-85",1985,2,0,"Campeonato Estadual","","Flamengo"],["2-mar.-86",1986,2,0,"Campeonato Estadual","","Flamengo"],["11-mai.-86",1986,1,2,"Campeonato Estadual","","Botafogo"],["28-mar.-87",1987,0,0,"Campeonato Estadual","",""],["10-mai.-87",1987,1,0,"Campeonato Estadual","","Flamengo"],["24-out.-87",1987,1,0,"Campeonato Brasileiro","","Flamengo"],["6-mar.-88",1988,0,0,"Campeonato Estadual","",""],["15-mai.-88",1988,1,1,"Campeonato Estadual","",""],["2-out.-88",1988,2,2,"Campeonato Brasileiro","Flamengo 5x4 nos penaltis.",""],["26-fev.-89",1989,1,1,"Campeonato Estadual","",""],["7-mai.-89",1989,3,3,"Campeonato Estadual","",""],["18-jun.-89",1989,0,0,"Campeonato Estadual","Decisão, primeiro jogo.",""],["21-jun.-89",1989,0,1,"Campeonato Estadual","Decisão, segundo jogo.","Botafogo"],["20-set.-89",1989,1,0,"Campeonato Brasileiro","","Flamengo"],["11-mar.-90",1990,1,2,"Campeonato Estadual","","Botafogo"],["28-abr.-90",1990,0,2,"Campeonato Estadual","","Botafogo"],["30-set.-90",1990,0,1,"Campeonato Brasileiro","","Botafogo"],["28-abr.-91",1991,0,0,"Campeonato Brasileiro","",""],["26-jun.-91",1991,0,0,"Copa Rio de Janeiro","",""],["29-set.-91",1991,2,1,"Campeonato Estadual","","Flamengo"],["8-dez.-91",1991,2,2,"Campeonato Estadual","",""],["11-dez.-91",1991,1,0,"Campeonato Estadual","","Flamengo"],["9-fev.-92",1992,2,2,"Campeonato Brasileiro","",""],["17-jun.-92",1992,2,0,"Copa Rio de Janeiro","","Flamengo"],["12-jul.-92",1992,3,0,"Campeonato Brasileiro","Decisão, primeiro jogo.","Flamengo"],["19-jul.-92",1992,2,2,"Campeonato Brasileiro","Decisão, segundo jogo. O empate deu o título ao Flamengo.",""],["13-set.-92",1992,0,1,"Campeonato Estadual","","Botafogo"],["8-nov.-92",1992,1,2,"Campeonato Estadual","","Botafogo"],["28-mar.-93",1993,1,1,"Campeonato Estadual","",""],["30-mai.-93",1993,4,1,"Campeonato Estadual","","Flamengo"],["26-set.-93",1993,1,0,"Campeonato Brasileiro","","Flamengo"],["12-nov.-93",1993,2,0,"Campeonato Brasileiro","","Flamengo"],["20-mar.-94",1994,1,1,"Campeonato Estadual","",""],["15-abr.-94",1994,3,1,"Campeonato Estadual","","Flamengo"],["13-mai.-94",1994,1,0,"Campeonato Estadual","","Flamengo"],["16-out.-94",1994,0,1,"Campeonato Brasileiro","","Botafogo"],["23-mar.-95",1995,3,2,"Campeonato Estadual","","Flamengo"],["16-abr.-95",1995,0,1,"Campeonato Estadual","","Botafogo"],["11-jun.-95",1995,1,0,"Campeonato Estadual","","Flamengo"],["24-set.-95",1995,1,3,"Campeonato Brasileiro","","Botafogo"],["3-mar.-96",1996,2,2,"Taça Cidade Maravilhosa","",""],["7-abr.-96",1996,2,0,"Campeonato Estadual","","Flamengo"],["2-jun.-96",1996,2,2,"Campeonato Estadual","",""],["15-set.-96",1996,2,0,"Campeonato Brasileiro","","Flamengo"],["26-mar.-97",1997,0,1,"Campeonato Estadual","","Botafogo"],["6-abr.-97",1997,2,2,"Campeonato Estadual","",""],["10-mai.-97",1997,1,1,"Campeonato Estadual","",""],["1-jun.-97",1997,0,0,"Amistoso","",""],["31-ago.-97",1997,0,0,"Campeonato Brasileiro","",""],["15-mar.-98",1998,3,0,"Campeonato Estadual","","Flamengo"],["26-abr.-98",1998,3,3,"Campeonato Estadual","",""],["26-jul.-98",1998,1,1,"Campeonato Brasileiro","",""],["28-jan.-99",1999,4,4,"Torneio Rio-São Paulo","",""],["10-fev.-99",1999,1,1,"Torneio Rio-São Paulo","",""],["28-mar.-99",1999,1,0,"Campeonato Estadual","","Flamengo"],["16-mai.-99",1999,0,1,"Campeonato Estadual","","Botafogo"],["10-out.-99",1999,1,2,"Campeonato Brasileiro","","Botafogo"],["26-jan.-00",2000,1,2,"Torneio Rio-São Paulo","","Botafogo"],["2-fev.-00",2000,2,2,"Torneio Rio-São Paulo","",""],["26-mar.-00",2000,1,2,"Campeonato Estadual","","Botafogo"],["14-mai.-00",2000,2,1,"Campeonato Estadual","","Flamengo"],["7-out.-00",2000,1,3,"Campeonato Brasileiro","","Botafogo"],["18-fev.-01",2001,0,1,"Campeonato Estadual","","Botafogo"],["1-abr.-01",2001,1,1,"Campeonato Estadual","",""],["10-out.-01",2001,2,2,"Campeonato Brasileiro","",""],["3-fev.-02",2002,2,4,"Torneio Rio-São Paulo","","Botafogo"],["18-mar.-02",2002,1,3,"Campeonato Estadual","","Botafogo"],["18-mai.-02",2002,0,1,"Campeonato Estadual","","Botafogo"],["2-nov.-02",2002,2,0,"Campeonato Brasileiro","","Flamengo"],["16-fev.-03",2003,4,2,"Campeonato Estadual","","Flamengo"],["14-mar.-04",2004,0,1,"Campeonato Estadual","","Botafogo"],["28-jul.-04",2004,0,0,"Campeonato Brasileiro","",""],["21-nov.-04",2004,0,0,"Campeonato Brasileiro","",""],["6-mar.-05",2005,2,2,"Campeonato Estadual","",""],["31-jul.-05",2005,2,0,"Campeonato Brasileiro","","Flamengo"],["6-nov.-05",2005,3,1,"Campeonato Brasileiro","","Flamengo"],["25-fev.-06",2006,3,2,"Campeonato Estadual","","Flamengo"],["7-mai.-06",2006,1,0,"Campeonato Brasileiro","","Flamengo"],["10-set.-06",2006,2,0,"Campeonato Brasileiro","","Flamengo"],["11-fev.-07",2007,3,3,"Campeonato Estadual","",""],["29-abr.-07",2007,2,2,"Campeonato Estadual","Decisão, primeiro jogo.",""],["6-mai.-07",2007,2,2,"Campeonato Estadual","Decisão, segundo jogo. O Flamengo venceu por 4x2 nos pênaltis e conquistou o campeonato.",""],["27-mai.-07",2007,2,2,"Campeonato Brasileiro","",""],["29-ago.-07",2007,1,1,"Campeonato Brasileiro","",""],["24-fev.-08",2008,2,1,"Campeonato Estadual","","Flamengo"],["16-mar.-08",2008,2,3,"Campeonato Estadual","","Botafogo"],["13-abr.-08",2008,0,3,"Campeonato Estadual","","Botafogo"],["27-abr.-08",2008,1,0,"Campeonato Estadual","Decisão, primeiro jogo.","Flamengo"],["4-mai.-08",2008,3,1,"Campeonato Estadual","Decisão, segundo jogo.","Flamengo"],["27-jul.-08",2008,0,0,"Campeonato Brasileiro","",""],["9-nov.-08",2008,1,0,"Campeonato Brasileiro","","Flamengo"],["15-fev.-09",2009,1,1,"Campeonato Estadual","",""],["19-abr.-09",2009,1,0,"Campeonato Estadual","","Flamengo"],["26-abr.-09",2009,2,2,"Campeonato Estadual","Decisão, primeiro jogo.",""],["3-mai.-09",2009,2,2,"Campeonato Estadual","Decisão, segundo jogo. O Flamengo venceu por 4x2 nos pênaltis e conquistou o campeonato.",""],["19-jul.-09",2009,2,2,"Campeonato Brasileiro","",""],["25-out.-09",2009,1,0,"Campeonato Brasileiro","","Flamengo"],["17-fev.-10",2010,1,2,"Campeonato Estadual","","Botafogo"],["21-mar.-10",2010,2,2,"Campeonato Estadual","",""],["18-abr.-10",2010,1,2,"Campeonato Estadual","Com esta vitória na final do segundo turno, o Botafogo conquistou o campeonato, pois já havia vencido também o primeiro turno.","Botafogo"],["14-jul.-10",2010,1,0,"Campeonato Brasileiro","","Flamengo"],["2-out.-10",2010,1,1,"Campeonato Brasileiro","",""],["20-fev.-11",2011,1,1,"Campeonato Estadual","Flamengo 3x1 nos pênaltis, classificado para a final do primeiro turno.",""],["10-abr.-11",2011,2,0,"Campeonato Estadual","","Flamengo"],["19-jun.-11",2011,0,0,"Campeonato Brasileiro","",""],["18-set.-11",2011,1,1,"Campeonato Brasileiro","",""],["5-fev.-12",2012,0,0,"Campeonato Estadual","",""],["26-ago.-12",2012,0,0,"Campeonato Brasileiro","",""],["1-dez.-12",2012,2,2,"Campeonato Brasileiro","",""],["17-fev.-13",2013,1,0,"Campeonato Estadual","","Flamengo"],["3-mar.-13",2013,0,2,"Campeonato Estadual","","Botafogo"],["28-jul.-13",2013,1,1,"Campeonato Brasileiro","",""],["25-set.-13",2013,1,1,"Copa do Brasil","",""],["13-out.-13",2013,1,2,"Campeonato Brasileiro","","Botafogo"],["23-out.-13",2013,4,0,"Copa do Brasil","","Flamengo"],["9-mar.-14",2014,2,0,"Campeonato Estadual","","Flamengo"],["27-jul.-14",2014,1,0,"Campeonato Brasileiro","","Flamengo"],["25-out.-14",2014,1,2,"Campeonato Brasileiro","","Botafogo"],["1-mar.-15",2015,0,1,"Campeonato Estadual","","Botafogo"],["2-abr.-16",2016,1,1,"Campeonato Estadual","",""],["16-jul.-16",2016,3,3,"Campeonato Brasileiro","",""],["5-nov.-16",2016,0,0,"Campeonato Brasileiro","",""],["12-fev.-17",2017,2,1,"Campeonato Estadual","","Flamengo"],["23-abr.-17",2017,2,1,"Campeonato Estadual","","Flamengo"],["4-jun.-17",2017,0,0,"Campeonato Brasileiro","",""],["16-ago.-17",2017,0,0,"Copa do Brasil","",""],["23-ago.-17",2017,1,0,"Copa do Brasil","","Flamengo"],["10-set.-17",2017,0,2,"Campeonato Brasileiro","","Botafogo"],["10-fev.-18",2018,3,1,"Campeonato Estadual","","Flamengo"],["3-mar.-18",2018,1,0,"Campeonato Estadual","","Flamengo"],["28-mar.-18",2018,0,1,"Campeonato Estadual","","Botafogo"],["21-jul.-18",2018,2,0,"Campeonato Brasileiro","","Flamengo"],["10-nov.-18",2018,1,2,"Campeonato Brasileiro","","Botafogo"],["26-jan.-19",2019,2,1,"Campeonato Estadual","","Flamengo"],["29-jul.-19",2019,3,2,"Campeonato Brasileiro","","Flamengo"],["7-nov.-19",2019,1,0,"Campeonato Brasileiro","","Flamengo"],["7-mar.-20",2020,3,0,"Campeonato Estadual","","Flamengo"],["23-ago.-20",2020,1,1,"Campeonato Brasileiro","",""],["5-dez.-20",2020,1,0,"Campeonato Brasileiro","","Flamengo"],["24-mar.-21",2021,2,0,"Campeonato Estadual","","Flamengo"],["23-fev.-22",2022,3,1,"Campeonato Estadual","","Flamengo"],["8-mai.-22",2022,0,1,"Campeonato Brasileiro","","Botafogo"],["28-ago.-22",2022,1,0,"Campeonato Brasileiro","","Flamengo"],["25-fev.-23",2023,1,0,"Campeonato Estadual","","Flamengo"],["30-abr.-23",2023,2,3,"Campeonato Brasileiro","","Botafogo"],["2-set.-23",2023,2,1,"Campeonato Brasileiro","","Flamengo"],["7-fev.-24",2024,1,0,"Campeonato Estadual","","Flamengo"],["28-abr.-24",2024,0,2,"Campeonato Brasileiro","","Botafogo"],["18-ago.-24",2024,1,4,"Campeonato Brasileiro","","Botafogo"],["2-fev.-25",2025,3,1,"Supercopa do Brasil","Final","Flamengo"],["12-fev.-25",2025,1,0,"Campeonato Estadual","","Flamengo"],["18-mai.-25",2025,0,0,"Campeonato Brasileiro","",""],["15-out.-25",2025,3,0,"Campeonato Brasileiro","","Flamengo"],["15-fev.-26",2026,2,1,"Campeonato Estadual","","Flamengo"],["14-mar.-26",2026,3,0,"Campeonato Brasileiro","","Flamengo"],["30-ago.-26",2026,3,0,"Campeonato Brasileiro","","Flamengo"]]},"vb":{"a":"Vasco","b":"Botafogo","rows":[["22-abr.-23",1923,3,1,"Campeonato Carioca","","Vasco"],["1-jul.-23",1923,3,2,"Campeonato Carioca","","Vasco"],["10-mai.-25",1925,2,2,"Campeonato Carioca","",""],["11-out.-25",1925,4,2,"Campeonato Carioca","","Vasco"],["16-mai.-26",1926,3,2,"Campeonato Carioca","","Vasco"],["21-mar.-26",1926,5,2,"Amistoso","","Vasco"],["11-abr.-26",1926,5,3,"Amistoso","","Vasco"],["1-ago.-26",1926,4,2,"Campeonato Carioca","","Vasco"],["30-out.-26",1926,3,3,"Amistoso","",""],["27-mar.-27",1927,5,4,"Amistoso","","Vasco"],["10-abr.-27",1927,6,3,"Amistoso","","Vasco"],["26-jun.-27",1927,3,3,"Campeonato Carioca","",""],["24-jul.-27",1927,1,1,"Campeonato Carioca","",""],["9/20/1928",1928,1,1,"Campeonato Carioca","Jogo iniciado em São Januário em 17 de junho e suspenso quando o Botafogo vencia por 1x0. Concluído em 20 de setembro na Rua Paysandu com o placar final de 1x1.",""],["21-out.-28",1928,1,3,"Campeonato Carioca","","Botafogo"],["23-jun.-29",1929,2,1,"Campeonato Carioca","Jogo iniciado nas Laranjeiras em 16 de junho e interrompido aos 20 min. do segundo tempo por falta de luz quando o Vasco vencia por 2x0. Concluído em 23 de junho no mesmo local com o placar final de 2x1 para o Vasco.","Vasco"],["20-out.-29",1929,2,2,"Campeonato Carioca","",""],["8-jun.-30",1930,1,2,"Campeonato Carioca","","Botafogo"],["30-nov.-30",1930,2,0,"Campeonato Carioca","","Vasco"],["27-set.-31",1931,1,1,"Campeonato Carioca","",""],["20-dez.-31",1931,0,3,"Campeonato Carioca","","Botafogo"],["27-mar.-32",1932,3,1,"Torneio Preparatório","","Vasco"],["10-jul.-32",1932,0,1,"Campeonato Carioca","","Botafogo"],["9-out.-32",1932,0,0,"Campeonato Carioca","",""],["9-dez.-34",1934,1,1,"Amistoso","",""],["30-dez.-34",1934,1,1,"Amistoso","",""],["6-jun.-35",1935,1,2,"Amistoso","","Botafogo"],["23-jun.-35",1935,4,0,"Campeonato Carioca","","Vasco"],["6-out.-35",1935,0,1,"Campeonato Carioca","O jogo realizado em São Januário em 15 de setembro foi anulado depois de ter sido suspenso por falta luz aos 69 min. de jogo com o placar de 1x1. Novo jogo foi realizado na íntegra em 6 de outubro no mesmo local.","Botafogo"],["5-jan.-36",1936,1,0,"Campeonato Carioca","","Vasco"],["14-mai.-36",1936,3,0,"Amistoso","","Vasco"],["26-jul.-36",1936,1,0,"Campeonato Carioca","","Vasco"],["1-nov.-36",1936,0,0,"Campeonato Carioca","",""],["11-abr.-37",1937,2,0,"Amistoso","","Vasco"],["1-out.-37",1937,2,2,"Campeonato Carioca","",""],["4-dez.-37",1937,3,2,"Campeonato Carioca","","Vasco"],["16-jun.-38",1938,2,1,"Torneio Municipal","","Vasco"],["10-jul.-38",1938,2,5,"Torneio Municipal","","Botafogo"],["2-out.-38",1938,0,0,"Campeonato Carioca","",""],["11-dez.-38",1938,1,2,"Campeonato Carioca","","Botafogo"],["28-mai.-39",1939,1,0,"Campeonato Carioca","","Vasco"],["20-ago.-39",1939,0,2,"Campeonato Carioca","","Botafogo"],["18-nov.-39",1939,2,2,"Campeonato Carioca","",""],["16-jun.-40",1940,3,0,"Campeonato Carioca","","Vasco"],["21-jul.-40",1940,3,4,"Campeonato Carioca / Torneio Rio-São Paulo","","Botafogo"],["13-out.-40",1940,2,2,"Campeonato Carioca","",""],["8-jun.-41",1941,5,3,"Campeonato Carioca","","Vasco"],["10-ago.-41",1941,1,1,"Campeonato Carioca","",""],["19-out.-41",1941,4,0,"Campeonato Carioca","","Vasco"],["23-nov.-41",1941,2,2,"Campeonato Carioca","",""],["7-jun.-42",1942,3,3,"Campeonato Carioca","",""],["9-ago.-42",1942,1,5,"Campeonato Carioca","","Botafogo"],["11-out.-42",1942,2,4,"Campeonato Carioca","","Botafogo"],["14-mar.-43",1943,2,1,"Torneio Relâmpago","","Vasco"],["22-mai.-43",1943,0,2,"Torneio Municipal","","Botafogo"],["24-jul.-43",1943,4,1,"Campeonato Carioca","","Vasco"],["26-set.-43",1943,3,1,"Campeonato Carioca","","Vasco"],["15-mar.-44",1944,3,0,"Torneio Relâmpago","","Vasco"],["10-jun.-44",1944,2,0,"Torneio Municipal","","Vasco"],["13-ago.-44",1944,1,2,"Campeonato Carioca","","Botafogo"],["14-out.-44",1944,1,0,"Campeonato Carioca","","Vasco"],["31-mar.-45",1945,2,1,"Torneio Relâmpago","","Vasco"],["3-jun.-45",1945,5,3,"Torneio Municipal","","Vasco"],["12-ago.-45",1945,1,0,"Campeonato Carioca","","Vasco"],["14-out.-45",1945,2,2,"Campeonato Carioca","",""],["27-mar.-46",1946,8,4,"Torneio Relâmpago","","Vasco"],["21-abr.-46",1946,1,1,"Torneio Municipal","",""],["7-jul.-46",1946,3,0,"Campeonato Carioca","","Vasco"],["8-set.-46",1946,1,1,"Campeonato Carioca","",""],["31-mai.-47",1947,0,4,"Torneio Municipal","","Botafogo"],["21-set.-47",1947,2,0,"Campeonato Carioca","","Vasco"],["7-dez.-47",1947,0,0,"Campeonato Carioca","",""],["13-jun.-48",1948,2,2,"Torneio Municipal","",""],["26-set.-48",1948,1,2,"Campeonato Carioca","","Botafogo"],["12-dez.-48",1948,1,3,"Campeonato Carioca","Decisão.","Botafogo"],["18-set.-49",1949,2,2,"Campeonato Carioca","",""],["11-dez.-49",1949,2,1,"Campeonato Carioca","","Vasco"],["5-fev.-50",1950,3,2,"Torneio Rio-São Paulo","","Vasco"],["8-out.-50",1950,0,1,"Campeonato Carioca","","Botafogo"],["14-jan.-51",1951,2,0,"Campeonato Carioca","","Vasco"],["20-jun.-51",1951,0,3,"Torneio Municipal","","Botafogo"],["29-set.-51",1951,1,1,"Campeonato Carioca","",""],["28-out.-51",1951,1,1,"Campeonato Carioca","",""],["8-mar.-52",1952,2,1,"Torneio Rio-São Paulo","","Vasco"],["11-mai.-52",1952,1,4,"Torneio Extra Carlos Martins da Rocha","","Botafogo"],["11-out.-52",1952,1,1,"Campeonato Carioca","",""],["30-nov.-52",1952,1,0,"Campeonato Carioca","","Vasco"],["16-mai.-53",1953,0,0,"Torneio Rio-São Paulo","",""],["21-jun.-53",1953,2,1,"Torneio Octogonal Rivadávia Correa Meyer","","Vasco"],["15-ago.-53",1953,4,1,"Campeonato Carioca","","Vasco"],["29-nov.-53",1953,2,1,"Campeonato Carioca","","Vasco"],["27-dez.-53",1953,1,1,"Campeonato Carioca","",""],["19-mai.-54",1954,5,3,"Torneio Rio-São Paulo","","Vasco"],["19-set.-54",1954,3,1,"Campeonato Carioca","","Vasco"],["22-dez.-54",1954,4,2,"Campeonato Carioca","","Vasco"],["2-fev.-55",1955,1,1,"Campeonato Carioca","",""],["20-mar.-55",1955,2,3,"Amistoso","","Botafogo"],["20-abr.-55",1955,1,2,"Torneio Rio-São Paulo","","Botafogo"],["30-out.-55",1955,3,2,"Campeonato Carioca","","Vasco"],["29-jan.-56",1956,2,1,"Campeonato Carioca","","Vasco"],["29-jul.-56",1956,0,0,"Campeonato Carioca","",""],["25-nov.-56",1956,3,2,"Campeonato Carioca","","Vasco"],["25-abr.-57",1957,3,2,"Torneio Rio-São Paulo","","Vasco"],["22-set.-57",1957,2,2,"Campeonato Carioca","",""],["10-nov.-57",1957,3,0,"Campeonato Carioca","","Vasco"],["26-mar.-58",1958,4,2,"Torneio Rio-São Paulo","","Vasco"],["11-jun.-58",1958,0,5,"Torneio Extra João Teixeira de Carvalho","Maior goleada do Botafogo sobre o Vasco.","Botafogo"],["14-jun.-58",1958,1,3,"Torneio Extra João Teixeira de Carvalho","","Botafogo"],["28-set.-58",1958,3,2,"Campeonato Carioca","","Vasco"],["7-dez.-58",1958,0,2,"Campeonato Carioca","","Botafogo"],["3-jan.-59",1959,0,1,"Campeonato Carioca","","Botafogo"],["10-jan.-59",1959,2,1,"Campeonato Carioca","","Vasco"],["30-abr.-59",1959,2,0,"Torneio Rio-São Paulo","","Vasco"],["29-ago.-59",1959,0,1,"Campeonato Carioca","","Botafogo"],["15-nov.-59",1959,4,2,"Campeonato Carioca","","Vasco"],["7-abr.-60",1960,1,1,"Torneio Rio-São Paulo","",""],["27-ago.-60",1960,2,0,"Campeonato Carioca","","Vasco"],["4-dez.-60",1960,1,2,"Campeonato Carioca","","Botafogo"],["18-mar.-61",1961,1,5,"Torneio Rio-São Paulo","","Botafogo"],["17-ago.-61",1961,1,1,"Campeonato Carioca","",""],["19-nov.-61",1961,0,4,"Campeonato Carioca","","Botafogo"],["22-dez.-61",1961,1,2,"Campeonato Carioca","","Botafogo"],["21-fev.-62",1962,1,4,"Torneio Rio-São Paulo","","Botafogo"],["4-ago.-62",1962,1,0,"Campeonato Carioca","","Vasco"],["4-nov.-62",1962,1,1,"Campeonato Carioca","",""],["13-mar.-63",1963,1,1,"Torneio Rio-São Paulo","",""],["3-set.-63",1963,0,2,"Campeonato Carioca","","Botafogo"],["22-nov.-63",1963,1,1,"Campeonato Carioca","",""],["15-abr.-64",1964,1,0,"Torneio Rio-São Paulo","","Vasco"],["19-ago.-64",1964,0,2,"Campeonato Carioca","","Botafogo"],["7-nov.-64",1964,0,2,"Campeonato Carioca","","Botafogo"],["24-mar.-65",1965,4,2,"Torneio Rio-São Paulo","","Vasco"],["20-mai.-65",1965,1,0,"Torneio Rio-São Paulo","","Vasco"],["11-ago.-65",1965,0,3,"Taça Guanabara","","Botafogo"],["5-set.-65",1965,2,0,"Taça Guanabara","Decisão.","Vasco"],["17-out.-65",1965,2,1,"Campeonato Carioca","","Vasco"],["4-dez.-65",1965,1,2,"Campeonato Carioca","","Botafogo"],["27-mar.-66",1966,0,3,"Torneio Rio-São Paulo","Decisão. Com a vitória do Botafogo, terminaram empatados em primeiro lugar Botafogo, Corinthians, Santos e Vasco. Por falta de datas para um desempate, os quatro foram declarados campeões.","Botafogo"],["27-ago.-66",1966,0,2,"Taça Guanabara","","Botafogo"],["7-set.-66",1966,1,2,"Amistoso","","Botafogo"],["25-out.-66",1966,1,2,"Campeonato Carioca","","Botafogo"],["18-dez.-66",1966,2,1,"Campeonato Carioca","","Vasco"],["26-abr.-67",1967,1,0,"Torneio Roberto Gomes Pedrosa","","Vasco"],["6-ago.-67",1967,3,2,"Taça Guanabara","","Vasco"],["5-nov.-67",1967,2,0,"Campeonato Carioca","","Vasco"],["13-dez.-67",1967,1,3,"Campeonato Carioca","","Botafogo"],["28-abr.-68",1968,2,0,"Campeonato Carioca","","Vasco"],["9-jun.-68",1968,0,4,"Campeonato Carioca","Decisão.","Botafogo"],["28-jul.-68",1968,1,1,"Taça Guanabara","",""],["5-out.-68",1968,2,1,"Taça de Prata","","Vasco"],["4-mai.-69",1969,0,1,"Campeonato Carioca","","Botafogo"],["4-jun.-69",1969,2,0,"Campeonato Carioca","","Vasco"],["6-jul.-69",1969,3,0,"Taça Guanabara","","Vasco"],["12-out.-69",1969,0,2,"Taça de Prata","","Botafogo"],["21-abr.-70",1970,0,0,"Taça Guanabara","",""],["31-mai.-70",1970,1,1,"Taça Guanabara","",""],["26-jul.-70",1970,0,0,"Campeonato Carioca","",""],["17-set.-70",1970,2,1,"Campeonato Carioca","","Vasco"],["27-set.-70",1970,0,1,"Taça de Prata","","Botafogo"],["6-abr.-71",1971,2,4,"Campeonato Carioca","Jogo iniciado no Maracanã em 26 de março, suspenso no primeiro tempo devido à chuva com o placar de 0 a 0 e posteriormente anulado. Nova partida foi realizada no mesmo local em 6 de abril, com o placar final de 4x2 para o Botafogo.","Botafogo"],["9-mai.-71",1971,0,0,"Campeonato Carioca","",""],["23-mai.-71",1971,1,2,"Campeonato Carioca","","Botafogo"],["6-jul.-71",1971,2,0,"Taça Guanabara","","Vasco"],["31-out.-71",1971,1,0,"Campeonato Brasileiro","","Vasco"],["5-mar.-72",1972,0,3,"Campeonato Carioca","","Botafogo"],["23-jul.-72",1972,2,1,"Campeonato Carioca","","Vasco"],["16-ago.-72",1972,0,0,"Campeonato Carioca","",""],["15-out.-72",1972,0,0,"Campeonato Brasileiro","",""],["22-abr.-73",1973,2,1,"Campeonato Carioca","","Vasco"],["14-jul.-73",1973,3,2,"Campeonato Carioca","","Vasco"],["5-ago.-73",1973,2,0,"Campeonato Carioca","","Vasco"],["16-dez.-73",1973,1,0,"Campeonato Brasileiro","","Vasco"],["30-mar.-74",1974,0,0,"Campeonato Brasileiro","",""],["25-ago.-74",1974,3,2,"Campeonato Carioca","","Vasco"],["13-out.-74",1974,2,1,"Campeonato Carioca","","Vasco"],["4-dez.-74",1974,1,1,"Campeonato Carioca","",""],["16-mar.-75",1975,1,1,"Campeonato Carioca","",""],["4-mai.-75",1975,0,1,"Campeonato Carioca","","Botafogo"],["2-ago.-75",1975,0,1,"Campeonato Carioca","","Botafogo"],["14-ago.-75",1975,2,0,"Campeonato Carioca","","Vasco"],["24-jan.-76",1976,2,0,"Amistoso","","Vasco"],["9-mai.-76",1976,2,1,"Campeonato Estadual","","Vasco"],["4-jul.-76",1976,1,3,"Campeonato Estadual","","Botafogo"],["25-jul.-76",1976,1,1,"Campeonato Estadual","",""],["22-ago.-76",1976,1,0,"Campeonato Estadual","","Vasco"],["18-fev.-77",1977,4,3,"Amistoso","","Vasco"],["29-mai.-77",1977,2,0,"Campeonato Estadual","","Vasco"],["21-ago.-77",1977,2,0,"Campeonato Estadual","","Vasco"],["13-nov.-77",1977,0,0,"Campeonato Brasileiro","",""],["23-abr.-78",1978,0,0,"Campeonato Brasileiro","",""],["14-out.-78",1978,2,2,"Campeonato Estadual","",""],["29-out.-78",1978,2,1,"Campeonato Estadual","","Vasco"],["18-fev.-79",1979,1,1,"Campeonato Estadual Especial","",""],["8-abr.-79",1979,2,0,"Campeonato Estadual Especial","","Vasco"],["1-jul.-79",1979,0,0,"Campeonato Estadual","",""],["22-set.-79",1979,1,1,"Campeonato Estadual","",""],["7-out.-79",1979,2,1,"Campeonato Estadual","","Vasco"],["6-jul.-80",1980,0,0,"Taça Guanabara","",""],["21-set.-80",1980,1,0,"Campeonato Estadual","","Vasco"],["9-nov.-80",1980,2,0,"Campeonato Estadual","","Vasco"],["21-jun.-81",1981,1,1,"Campeonato Estadual","",""],["13-set.-81",1981,0,0,"Campeonato Estadual","",""],["11-out.-81",1981,1,3,"Campeonato Estadual","","Botafogo"],["28-abr.-82",1982,0,0,"Torneio dos Campeões","",""],["15-mai.-82",1982,3,3,"Torneio dos Campeões","",""],["5-set.-82",1982,1,0,"Campeonato Estadual","","Vasco"],["7-nov.-82",1982,1,4,"Campeonato Estadual","","Botafogo"],["24-jul.-83",1983,2,3,"Campeonato Estadual","","Botafogo"],["9-out.-83",1983,0,1,"Campeonato Estadual","","Botafogo"],["16-set.-84",1984,3,0,"Campeonato Estadual","","Vasco"],["25-nov.-84",1984,2,1,"Campeonato Estadual","","Vasco"],["3-mar.-85",1985,1,3,"Campeonato Brasileiro","","Botafogo"],["10-abr.-85",1985,2,1,"Campeonato Brasileiro","","Vasco"],["15-set.-85",1985,0,0,"Campeonato Estadual","",""],["10-nov.-85",1985,1,0,"Campeonato Estadual","","Vasco"],["6-abr.-86",1986,0,2,"Campeonato Estadual","","Botafogo"],["27-abr.-86",1986,3,2,"Campeonato Estadual","","Vasco"],["15-mar.-87",1987,0,0,"Campeonato Estadual","",""],["26-abr.-87",1987,2,1,"Campeonato Estadual","","Vasco"],["1-out.-87",1987,1,0,"Campeonato Brasileiro","","Vasco"],["28-mar.-88",1988,4,3,"Campeonato Estadual","","Vasco"],["23-mai.-88",1988,3,0,"Campeonato Estadual","","Vasco"],["1-dez.-88",1988,3,0,"Campeonato Brasileiro","","Vasco"],["12-mar.-89",1989,0,0,"Campeonato Estadual","",""],["14-mai.-89",1989,1,1,"Campeonato Estadual","",""],["29-nov.-89",1989,2,2,"Campeonato Brasileiro","",""],["18-fev.-90",1990,1,1,"Campeonato Estadual","",""],["18-mar.-90",1990,1,1,"Campeonato Estadual","",""],["29-jul.-90",1990,0,1,"Campeonato Estadual","Decisão.","Botafogo"],["6-nov.-90",1990,2,2,"Campeonato Brasileiro","",""],["2-dez.-90",1990,2,2,"Torneio Extra (Taça Adolpho Bloch)","",""],["16-dez.-90",1990,1,1,"Torneio Extra (Taça Adolpho Bloch)","",""],["14-abr.-91",1991,3,0,"Campeonato Brasileiro","","Vasco"],["20-jun.-91",1991,2,0,"Copa Rio de Janeiro","","Vasco"],["2-jul.-91",1991,0,1,"Copa Rio de Janeiro","","Botafogo"],["25-ago.-91",1991,1,1,"Campeonato Estadual","",""],["3-nov.-91",1991,3,3,"Campeonato Estadual","",""],["12-abr.-92",1992,2,1,"Campeonato Brasileiro","","Vasco"],["24-jun.-92",1992,2,1,"Copa Rio de Janeiro","","Vasco"],["7-set.-92",1992,1,0,"Campeonato Estadual","","Vasco"],["14-nov.-92",1992,3,1,"Campeonato Estadual","","Vasco"],["7-mar.-93",1993,2,0,"Campeonato Estadual","","Vasco"],["9-mai.-93",1993,2,1,"Campeonato Estadual","","Vasco"],["26-jun.-93",1993,1,1,"Torneio Rio-São Paulo","",""],["17-jul.-93",1993,2,1,"Torneio Rio-São Paulo","","Vasco"],["1-out.-93",1993,2,1,"Copa Rio de Janeiro","","Vasco"],["6-mar.-94",1994,2,0,"Campeonato Estadual","","Vasco"],["10-abr.-94",1994,1,0,"Campeonato Estadual","","Vasco"],["6-mai.-94",1994,3,1,"Campeonato Estadual","","Vasco"],["23-nov.-94",1994,0,0,"Campeonato Brasileiro","",""],["19-fev.-95",1995,1,1,"Campeonato Estadual","",""],["19-mar.-95",1995,0,2,"Campeonato Estadual","","Botafogo"],["23-abr.-95",1995,1,0,"Campeonato Estadual","","Vasco"],["19-jun.-95",1995,1,1,"Campeonato Estadual","",""],["6-nov.-95",1995,1,2,"Copa Rio de Janeiro","","Botafogo"],["21-nov.-95",1995,0,0,"Copa Rio de Janeiro","",""],["26-nov.-95",1995,0,2,"Campeonato Brasileiro","","Botafogo"],["17-fev.-96",1996,3,5,"Taça Cidade Maravilhosa","","Botafogo"],["24-mar.-96",1996,2,3,"Campeonato Estadual","","Botafogo"],["26-mai.-96",1996,0,1,"Campeonato Estadual","","Botafogo"],["14-jul.-96",1996,0,2,"Torneio Rio-Brasília (Taça Rede Bandeirantes)","","Botafogo"],["3-nov.-96",1996,2,1,"Campeonato Brasileiro","","Vasco"],["9-mar.-97",1997,1,2,"Campeonato Estadual","","Botafogo"],["30-mar.-97",1997,0,1,"Campeonato Estadual","","Botafogo"],["27-abr.-97",1997,0,1,"Campeonato Estadual","","Botafogo"],["24-mai.-97",1997,2,0,"Campeonato Estadual","","Vasco"],["5-jul.-97",1997,1,0,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["8-jul.-97",1997,0,1,"Campeonato Estadual","Decisão, segundo jogo. Botafogo campeão.","Botafogo"],["19-out.-97",1997,1,0,"Campeonato Brasileiro","","Vasco"],["24-jan.-98",1998,1,0,"Torneio Rio-São Paulo","","Vasco"],["7-fev.-98",1998,2,2,"Torneio Rio-São Paulo","",""],["10-mai.-98",1998,3,0,"Campeonato Estadual","O Botafogo não compareceu para o jogo e o Vasco ganhou os pontos para efeito de classificação. Não computado para efeito de estatística.","Vasco"],["29-mar.-98",1998,1,2,"Campeonato Estadual","","Botafogo"],["27-set.-98",1998,2,0,"Campeonato Brasileiro","","Vasco"],["11-abr.-99",1999,1,0,"Campeonato Estadual","","Vasco"],["30-mai.-99",1999,1,1,"Campeonato Estadual","",""],["15-ago.-99",1999,2,1,"Campeonato Brasileiro","","Vasco"],["9-abr.-00",2000,0,0,"Campeonato Estadual","",""],["7-jun.-00",2000,1,1,"Campeonato Estadual","",""],["11-dez.-00",2000,1,2,"Campeonato Brasileiro","","Botafogo"],["29-abr.-01",2001,7,0,"Campeonato Estadual","Maior goleada do Vasco sobre o Botafogo.","Vasco"],["13-out.-01",2001,3,1,"Campeonato Brasileiro","","Vasco"],["18-fev.-02",2002,1,0,"Campeonato Estadual","","Vasco"],["21-mar.-02",2002,2,2,"Torneio Rio-São Paulo","",""],["29-mai.-02",2002,2,2,"Campeonato Estadual","",""],["8-jun.-02",2002,0,1,"Campeonato Estadual","","Botafogo"],["15-set.-02",2002,1,1,"Campeonato Brasileiro","",""],["26-jan.-03",2003,1,1,"Campeonato Estadual","",""],["8-fev.-04",2004,1,1,"Campeonato Estadual","",""],["30-mai.-04",2004,4,0,"Campeonato Brasileiro","","Vasco"],["19-set.-04",2004,2,2,"Campeonato Brasileiro","",""],["30-jan.-05",2005,1,1,"Campeonato Estadual","",""],["7-set.-05",2005,2,2,"Campeonato Brasileiro","",""],["19-out.-05",2005,1,0,"Campeonato Brasileiro","O jogo realizado em São Januário em 8 de maio de 2005 (Botafogo 1x0) foi anulado por deliberação do STJD. O STJD considerou suspeitas e anulou todas as partidas do Campeonato Brasileiro arbitradas por Edílson Pereira de Carvalho (SP), que teria se vendido a uma máfia de apostadores. Novo jogo foi realizado na íntegra em 19 de outubro no mesmo local.","Vasco"],["22-jan.-06",2006,3,5,"Campeonato Estadual","","Botafogo"],["25-mai.-06",2006,1,4,"Campeonato Brasileiro","","Botafogo"],["24-set.-06",2006,0,0,"Campeonato Brasileiro","",""],["1-abr.-07",2007,0,2,"Campeonato Estadual","","Botafogo"],["11-abr.-07",2007,4,4,"Campeonato Estadual","Botafogo 4x1 nos pênaltis, classificado para a final do segundo turno (Taça Rio).",""],["14-jun.-07",2007,0,4,"Campeonato Brasileiro","O jogador do Botafogo Dodô foi flagrado no exame anti-doping, julgado culpado num primeiro julgamento e posteriormente absolvido. No julgamento definitivo, foi suspenso por dois anos pelo Tribunal Arbitral do Esporte.","Botafogo"],["14-out.-07",2007,2,1,"Campeonato Brasileiro","","Vasco"],["2-fev.-08",2008,2,3,"Campeonato Estadual","","Botafogo"],["25-mai.-08",2008,1,1,"Campeonato Brasileiro","",""],["24-ago.-08",2008,1,1,"Campeonato Brasileiro","",""],["12-mar.-09",2009,4,1,"Campeonato Estadual","","Vasco"],["11-abr.-09",2009,0,4,"Campeonato Estadual","","Botafogo"],["24-jan.-10",2010,6,0,"Campeonato Estadual","","Vasco"],["21-fev.-10",2010,0,2,"Campeonato Estadual","","Botafogo"],["30-mai.-10",2010,1,1,"Campeonato Brasileiro","",""],["22-set.-10",2010,2,2,"Campeonato Brasileiro","",""],["20-mar.-11",2011,2,0,"Campeonato Estadual","","Vasco"],["7-ago.-11",2011,0,4,"Campeonato Brasileiro","","Botafogo"],["13-nov.-11",2011,2,0,"Campeonato Brasileiro","","Vasco"],["18-mar.-12",2012,1,3,"Campeonato Estadual","","Botafogo"],["29-abr.-12",2012,1,3,"Campeonato Estadual","","Botafogo"],["25-jul.-12",2012,1,0,"Campeonato Brasileiro","","Vasco"],["18-out.-12",2012,2,3,"Campeonato Brasileiro","","Botafogo"],["10-mar.-13",2013,0,1,"Campeonato Estadual","","Botafogo"],["3-abr.-13",2013,0,3,"Campeonato Estadual","","Botafogo"],["4-ago.-13",2013,2,3,"Campeonato Brasileiro","","Botafogo"],["20-out.-13",2013,2,2,"Campeonato Brasileiro","",""],["2-fev.-14",2014,1,0,"Campeonato Estadual","","Vasco"],["29-mar.-15",2015,1,1,"Campeonato Estadual","",""],["26-abr.-15",2015,1,0,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["3-mai.-15",2015,2,1,"Campeonato Estadual","Decisão, segundo jogo. Vasco campeão.","Vasco"],["22-fev.-16",2016,1,1,"Campeonato Estadual","",""],["27-mar.-16",2016,1,0,"Campeonato Estadual","","Vasco"],["1-mai.-16",2016,1,0,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["8-mai.-16",2016,1,1,"Campeonato Estadual","Decisão, segundo jogo. Vasco campeão.",""],["19-mar.-17",2017,0,0,"Campeonato Estadual","",""],["16-abr.-17",2017,2,0,"Campeonato Estadual","","Vasco"],["21-jun.-17",2017,1,3,"Campeonato Brasileiro","","Botafogo"],["14-out.-17",2017,1,0,"Campeonato Brasileiro","","Vasco"],["18-mar.-18",2018,3,2,"Campeonato Estadual","","Vasco"],["21-mar.-18",2018,2,3,"Campeonato Estadual","","Botafogo"],["1-abr.-18",2018,3,2,"Campeonato Estadual","Decisão, primeiro jogo.","Vasco"],["8-abr.-18",2018,0,1,"Campeonato Estadual","Decisão, segundo jogo. O Botafogo venceu nos pênaltis por 4x3 e conquistou o campeonato.","Botafogo"],["2-jun.-18",2018,1,2,"Campeonato Brasileiro","","Botafogo"],["9-out.-18",2018,1,1,"Campeonato Brasileiro","",""],["23-fev.-19",2019,1,1,"Campeonato Estadual","",""],["2-jun.-19",2019,0,1,"Campeonato Brasileiro","","Botafogo"],["16-out.-19",2019,2,1,"Campeonato Brasileiro","","Vasco"],["2-fev.-20",2020,0,1,"Campeonato Estadual","","Botafogo"],["13-set.-20",2020,3,2,"Campeonato Brasileiro","","Vasco"],["17-set.-20",2020,0,1,"Campeonato Brasileiro","","Botafogo"],["23-set.-20",2020,0,0,"Campeonato Brasileiro","",""],["10-jan.-21",2021,3,0,"Campeonato Brasileiro","","Vasco"],["21-mar.-21",2021,1,1,"Campeonato Estadual","",""],["16-mai.-21",2021,1,0,"Campeonato Estadual","Taça Rio, primeiro jogo.","Vasco"],["22-mai.-21",2021,0,1,"Campeonato Estadual","Taça Rio, segundo jogo. Vasco 3x0 nos pênaltis, vencedor da Taça Rio.","Botafogo"],["31-jul.-21",2021,0,2,"Campeonato Brasileiro Série B","","Botafogo"],["7-nov.-21",2021,0,4,"Campeonato Brasileiro Série B","","Botafogo"],["13-fev.-22",2022,0,1,"Campeonato Estadual","","Botafogo"],["16-fev.-23",2023,2,0,"Campeonato Estadual","","Vasco"],["2-jul.-23",2023,0,2,"Campeonato Brasileiro","","Botafogo"],["6-nov.-23",2023,1,0,"Campeonato Brasileiro","","Vasco"],["18-fev.-24",2024,4,2,"Campeonato Estadual","","Vasco"],["29-jun.-24",2024,1,1,"Campeonato Brasileiro","",""],["5-nov.-24",2024,0,3,"Campeonato Brasileiro","","Botafogo"],["23-fev.-25",2025,1,0,"Campeonato Estadual","","Vasco"],["12-jul.-25",2025,0,2,"Campeonato Brasileiro","","Botafogo"],["27-ago.-25",2025,1,1,"Copa do Brasil","",""],["11-set.-25",2025,1,1,"Copa do Brasil","Vasco classificado penaltis",""],["5-nov.-25",2025,0,3,"Campeonato Brasileiro","","Botafogo"],["8-fev.-26",2026,2,0,"Campeonato Estadual","","Vasco"],["4-abr.-26",2026,1,2,"Campeonato Brasileiro","","Botafogo"],["7-out.-26",2026,2,1,"Campeonato Brasileiro","","Vasco"]]}};
const RIVALS_COLORS={Flamengo:'#d52c32',Vasco:'#151a1d',Botafogo:'#697983',Empates:'#b7c0c7'};
let rivalsActiveTab='fv',rivalsChart=null;
function rivalsStats(key){
 const d=RIVALS_DATA[key],wins={[d.a]:0,[d.b]:0},byYear={};
 d.rows.forEach(r=>{if(r[6])wins[r[6]]++;const y=byYear[r[1]]||(byYear[r[1]]=[0,0]);if(r[6]===d.a)y[0]++;if(r[6]===d.b)y[1]++;});
 return {wins,draws:d.rows.length-wins[d.a]-wins[d.b],byYear};
}
function toggleRivalsMenu(){const m=document.getElementById('rivals-menu');const open=m.classList.toggle('hidden')===false;document.getElementById('rivals-menu-button').setAttribute('aria-expanded',String(open));}
function openRivalsView(){
 ['view-capa','view-estadio','view-classicos'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
 document.getElementById('view-rivais').classList.remove('hidden');document.getElementById('rivals-menu').classList.add('hidden');
 document.getElementById('rivals-menu-button').setAttribute('aria-expanded','false');
 markActiveTabs(['tab-btn-capa','tab-btn-estadio','tab-btn-classicos'],'');initRivalsFilters();renderRivals();window.scrollTo({top:0,behavior:'smooth'});
}
// V3.2.56 — Perspectiva independente por confronto, sem alterar os filtros gerais.
const rivalsCardPerspective = {};
function renderRivalsBarsOnly(){
 const bars=document.getElementById('rivals-bars');if(!bars)return;bars.replaceChildren();
 Object.entries(RIVALS_DATA).forEach(([key,d])=>{
  const filtered=rivalsFilteredRows(d),s=rivalsStatsFiltered(d,filtered),total=filtered.length;
  const selected=rivalsCardPerspective[key]===d.b?d.b:d.a;
  const other=selected===d.a?d.b:d.a;
  const wins=s.wins[selected],losses=s.wins[other],saldo=wins-losses;
  const goalsA=filtered.reduce((sum,r)=>sum+(Number(r[2])||0),0);
  const goalsB=filtered.reduce((sum,r)=>sum+(Number(r[3])||0),0);
  const goalsFor=selected===d.a?goalsA:goalsB,goalsAgainst=selected===d.a?goalsB:goalsA;
  const rate=total?(3*wins+s.draws)/(3*total)*100:0;
  const row=document.createElement('div');row.className='rivals-comparison-row';
  const header=document.createElement('div');header.className='rivals-comparison-header';
  const title=document.createElement('div');title.className='rivals-comparison-title';
  [d.a,d.b].forEach((name,i)=>{
   if(i){const cross=document.createElement('span');cross.textContent=' × ';cross.className='rivals-comparison-cross';title.append(cross);}
   const button=document.createElement('button');button.type='button';button.className='rivals-team-choice';
   button.textContent=name;button.dataset.team=name;button.setAttribute('aria-pressed',String(name===selected));
   button.title='Ver estatísticas do '+name;
   button.addEventListener('click',()=>{rivalsCardPerspective[key]=name;renderRivalsBarsOnly();});
   title.append(button);
  });
  const count=document.createElement('span');count.className='rivals-comparison-total';count.textContent=total.toLocaleString('pt-BR')+' jogos';
  header.append(title,count);
  const bar=document.createElement('div');bar.className='rivals-bar rivals-comparison-bar';
  bar.setAttribute('role','img');bar.setAttribute('aria-label',`${selected}: ${wins} vitórias, ${s.draws} empates, ${losses} derrotas`);
  [[selected,wins],['Empates',s.draws],[other,losses]].forEach(([name,n])=>{
   if(!n)return;
   const seg=document.createElement('span');seg.className='rivals-bar-segment';seg.style.background=RIVALS_COLORS[name];
   seg.style.width=(total?n/total*100:0)+'%';seg.textContent=n.toLocaleString('pt-BR');
   if(name==='Empates')seg.classList.add('rivals-segment-draw');
   seg.title=name+': '+n+' ('+(total?n/total*100:0).toFixed(1)+'%)';bar.append(seg);
  });
  if(!total){bar.textContent='Sem jogos no período';bar.classList.add('rivals-bar-empty');}
  const metrics=document.createElement('div');metrics.className='rivals-comparison-metrics';
  [['Aproveitamento',total?rate.toFixed(1).replace('.',',')+'%':'—'],['Gols pró',total?goalsFor.toLocaleString('pt-BR'):'—'],['Gols contra',total?goalsAgainst.toLocaleString('pt-BR'):'—'],['Saldo (V-D)',total?(saldo>0?'+':'')+saldo:'—']].forEach(([label,value],i)=>{
   const metric=document.createElement('div');metric.className='rivals-comparison-metric';
   const name=document.createElement('small');name.textContent=label;
   const val=document.createElement('strong');val.textContent=value;
   if(i===0&&total)val.style.color=recentRateColor(rate);
   if(i===3&&total)val.classList.add(saldo>0?'saldo-positive':saldo<0?'saldo-negative':'saldo-neutral');
   metric.append(name,val);metrics.append(metric);
  });
  row.append(header,bar,metrics);bars.append(row);
 });
}
function renderRivals(){
 renderRivalsBarsOnly();
 const legend=document.getElementById('rivals-legend');legend.replaceChildren();
 ['Flamengo','Vasco','Botafogo','Empates'].forEach(name=>{const item=document.createElement('span'),dot=document.createElement('i');dot.style.background=RIVALS_COLORS[name];item.append(dot,document.createTextNode(name));legend.append(item);});
 setRivalsTab(rivalsActiveTab);renderRivalsChart();renderRivalsInsights();
}

function setRivalsTab(key){
 const d=RIVALS_DATA[key];if(!d)return;rivalsActiveTab=key;
 document.querySelectorAll('[data-rivals-tab]').forEach(b=>b.classList.toggle('is-active',b.dataset.rivalsTab===key));
 const filtered=rivalsFilteredRows(d),s=rivalsStatsFiltered(d,filtered),box=document.getElementById('rivals-details');if(!box)return;box.replaceChildren();
 const summary=document.createElement('p');summary.className='rivals-summary';summary.textContent=filtered.length+' jogos · '+d.a+': '+s.wins[d.a]+' vitórias · Empates: '+s.draws+' · '+d.b+': '+s.wins[d.b]+' vitórias';box.append(summary);
 const wrap=document.createElement('div');wrap.className='rivals-table-wrap';const table=document.createElement('table');table.className='rivals-table';
 const thead=document.createElement('thead');thead.innerHTML='<tr><th>Data</th><th>Confronto</th><th>Placar</th><th>Competição</th><th>Observações</th></tr>';const tbody=document.createElement('tbody');
 [...filtered].reverse().forEach(r=>{
  const tr=document.createElement('tr');
  [formatRivalsTableDate(r),d.a+' × '+d.b,r[2]+' × '+r[3],r[4],r[5]||'—'].forEach((v,i)=>{
   const td=document.createElement('td');td.textContent=v;
   if(i===0)td.className='rivals-cell-date';
   if(i===1)td.className='rivals-cell-confronto';
   tr.append(td);
  });tbody.append(tr);
 });
 table.append(thead,tbody);wrap.append(table);box.append(wrap);
}
function formatRivalsTableDate(row) {
 const raw=String(row[0]||'').trim();
 const year=Number(row[1]);
 const monthNames=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
 const pt=raw.toLowerCase().match(/^(\d{1,2})[-\s]([a-zç]+)\.?[-\s](\d{2,4})$/);
 if(pt){
  const month=monthNames.findIndex(m=>pt[2].startsWith(m));
  if(month>=0)return pt[1].padStart(2,'0')+'/'+String(month+1).padStart(2,'0')+'/'+String(Number.isFinite(year)&&year>0?year:pt[3]);
 }
 const slash=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 if(slash){
  const a=Number(slash[1]),b=Number(slash[2]);
  // Original rivals CSV uses month/day/year when the second field exceeds 12.
  const month=b>12?a:b,day=b>12?b:a;
  return String(day).padStart(2,'0')+'/'+String(month).padStart(2,'0')+'/'+slash[3];
 }
 const timestamp=parseRivalsDate(row);
 if(Number.isFinite(timestamp)){
  const d=new Date(timestamp);
  return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
 }
 return raw;
}
function parseRivalsDate(row) {
  const raw=String(row[0]).toLowerCase();
  const monthNames=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const match=raw.match(/^(\d{1,2})-([a-zç]+)\.?-(\d{2,4})$/);
  if(match) {const m=monthNames.findIndex(v=>match[2].startsWith(v));return new Date(row[1],Math.max(0,m),Number(match[1])).getTime();}
  const slash=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(slash)return new Date(Number(slash[3]),Number(slash[1])-1,Number(slash[2])).getTime();
  return new Date(row[1],0,1).getTime();
}
function renderRivalsChart(){
 const canvas=document.getElementById('chartEvolucaoRivais');if(!canvas||typeof Chart==='undefined')return;
 if(rivalsChart)rivalsChart.destroy();
 const keys=Object.keys(RIVALS_DATA),colors=['#d52c32','#6e93a2','#c5a059'];
 let labels,datasets;
 if(rivalsSaldoMode==='anos') {
   const years=[...new Set(Object.values(RIVALS_DATA).flatMap(d=>rivalsFilteredRows(d).map(r=>r[1])))].sort((a,b)=>a-b);
   labels=years.map(String);
   datasets=keys.map((key,idx)=>{
     const d=RIVALS_DATA[key],byYear=rivalsStatsFiltered(d,rivalsFilteredRows(d)).byYear;let saldo=0;
     return {label:d.a+' × '+d.b,data:years.map(y=>{if(byYear[y])saldo+=byYear[y][0]-byYear[y][1];return y<d.rows[0][1]?null:saldo;}),borderColor:colors[idx],backgroundColor:colors[idx],borderWidth:2.5,pointRadius:0,pointHoverRadius:4,spanGaps:false,tension:0};
   });
 } else {
   // Each chronological match is one event; other series keep their current balance.
   const events=keys.flatMap(key=>rivalsFilteredRows(RIVALS_DATA[key]).map((r,i)=>({key,row:r,time:parseRivalsDate(r),order:i})));
   events.sort((a,b)=>a.time-b.time||keys.indexOf(a.key)-keys.indexOf(b.key)||a.order-b.order);
   labels=events.map(e=>e.row[0]);
   const balances=Object.fromEntries(keys.map(k=>[k,0]));
   const series=Object.fromEntries(keys.map(k=>[k,[]]));
   const started=new Set();
   events.forEach(e=>{
     const d=RIVALS_DATA[e.key];
     if(e.row[6]===d.a)balances[e.key]++;
     else if(e.row[6]===d.b)balances[e.key]--;
     started.add(e.key);
     keys.forEach(k=>series[k].push(started.has(k)?balances[k]:null));
   });
   datasets=keys.map((key,idx)=>{const d=RIVALS_DATA[key];return {label:d.a+' × '+d.b,data:series[key],borderColor:colors[idx],backgroundColor:colors[idx],borderWidth:2.5,pointRadius:0,pointHoverRadius:4,spanGaps:false,tension:0};});
 }
 const light=document.documentElement.dataset.theme==='light',tick=light?'#476252':'#d6e6db',grid=light?'rgba(35,90,58,.14)':'rgba(255,255,255,.12)';
 rivalsChart=new Chart(canvas,{type:'line',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:tick,usePointStyle:true,boxWidth:10}},tooltip:{callbacks:{title:items=>(rivalsSaldoMode==='anos'?'Ano: ':'Data: ')+items[0].label,label:item=>item.dataset.label+': '+item.formattedValue}}},scales:{x:{ticks:{color:tick,maxTicksLimit:12},grid:{color:grid}},y:{ticks:{color:tick,precision:0},grid:{color:ctx=>ctx.tick.value===0?(light?'#476252':'#d6e6db'):grid,lineWidth:ctx=>ctx.tick.value===0?2:1}}}}});
}
function setSaldoMode(view,mode) {
 if(!['partidas','anos'].includes(mode)||!['classicos','rivais'].includes(view))return;
 if(view==='classicos') {classicosSaldoMode=mode;if(lastClassicosSaldoData)updateClassicosChart(lastClassicosSaldoData);}
 else {rivalsSaldoMode=mode;renderRivalsChart();}
 document.querySelectorAll('[data-saldo-view="'+view+'"]').forEach(btn=>{
   const active=btn.dataset.saldoMode===mode;btn.classList.toggle('is-active',active);btn.setAttribute('aria-pressed',String(active));
 });
}
document.addEventListener('click',event=>{const wrap=document.getElementById('rivals-menu-wrap');if(wrap&&!wrap.contains(event.target))document.getElementById('rivals-menu')?.classList.add('hidden');if(event.target.closest('#theme-toggle')&&!document.getElementById('view-rivais')?.classList.contains('hidden'))requestAnimationFrame(renderRivalsChart);});

// V3.2.42 — Filtros gerais e cards de desempenho dos rivais.
const rivalsFilterState={competitions:null,minYear:null,maxYear:null,team:'Flamengo',opponents:['Vasco','Botafogo','Fluminense']};
const rivalsInsightOpen={recent:false,wins:false,unbeaten:false};
let rivalsInsightLists={recent:[],wins:[],unbeaten:[]};
function normalizeRivalsCompetition(value){
 return normalizeText(value).replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g,'').replace(/[\u2010-\u2015]/g,'-').normalize('NFKC').replace(/\s+/g,' ').trim();
}
function rivalsCompetitionKey(value){
 return normalizeComparable(normalizeRivalsCompetition(value));
}
function rivalsCompetitionSelected(value){
 const chosen=rivalsFilterState.competitions;
 return chosen===null || chosen.includes(rivalsCompetitionKey(value));
}
function rivalsFilteredRows(d){
 return d.rows.filter(r=>rivalsCompetitionSelected(r[4]) &&
 (rivalsFilterState.minYear===null||r[1]>=rivalsFilterState.minYear)&&
 (rivalsFilterState.maxYear===null||r[1]<=rivalsFilterState.maxYear));
}
function rivalsStatsFiltered(d,rows){
 const wins={[d.a]:0,[d.b]:0},byYear={};
 rows.forEach(r=>{if(r[6]===d.a||r[6]===d.b)wins[r[6]]++;const y=byYear[r[1]]||(byYear[r[1]]=[0,0]);if(r[6]===d.a)y[0]++;if(r[6]===d.b)y[1]++;});
 return {wins,draws:rows.length-wins[d.a]-wins[d.b],byYear};
}
function initRivalsFilters(){
 const select=document.getElementById('rivals-competition');if(!select||select.dataset.initialized)return;
 const all=Object.values(RIVALS_DATA).flatMap(d=>d.rows);
 const years=all.map(r=>r[1]).filter(Number.isFinite),min=Math.min(...years),max=Math.max(...years);
 rivalsFilterState.minYear=min;rivalsFilterState.maxYear=max;
 const competitionLabels=new Map();
 all.map(r=>r[4]).filter(Boolean).forEach(value=>{
  const key=rivalsCompetitionKey(value);
  if(!competitionLabels.has(key))competitionLabels.set(key,normalizeRivalsCompetition(value));
 });
 const competitions=[...competitionLabels.entries()].sort((a,b)=>a[1].localeCompare(b[1],'pt-BR'));
 const trigger=document.createElement('button');trigger.type='button';trigger.className='rivals-competition-trigger';
 trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-haspopup','true');
 const panel=document.createElement('div');panel.className='rivals-competition-panel';panel.hidden=true;
 const refresh=()=>{
  const chosen=rivalsFilterState.competitions;
  trigger.textContent=chosen===null?'Todas':chosen.length===0?'Nenhuma competição':chosen.length===1?(competitionLabels.get(chosen[0])||'1 competição'):chosen.length+' competições selecionadas';
  panel.querySelectorAll('input').forEach(input=>{
   input.checked=input.value==='__all__'?chosen===null:chosen===null||chosen.includes(input.value);
  });
 };
 const addOption=(key,label)=>{
  const row=document.createElement('label'),checkbox=document.createElement('input');
  checkbox.type='checkbox';checkbox.value=key;checkbox.checked=true;
  row.append(checkbox,document.createTextNode(label));
  checkbox.addEventListener('change',()=>{
   if(key==='__all__')rivalsFilterState.competitions=checkbox.checked?null:[];
   else{
    const current=rivalsFilterState.competitions===null?competitions.map(([k])=>k):rivalsFilterState.competitions.slice();
    const next=checkbox.checked?[...new Set([...current,key])]:current.filter(k=>k!==key);
    rivalsFilterState.competitions=next.length===competitions.length?null:next;
   }
   refresh();renderRivals();
  });
  panel.append(row);
 };
 addOption('__all__','Todas');
 competitions.forEach(([key,label])=>addOption(key,label));
 trigger.addEventListener('click',()=>{
  panel.hidden=!panel.hidden;trigger.setAttribute('aria-expanded',String(!panel.hidden));
 });
 select.replaceChildren(trigger,panel);refresh();
 document.addEventListener('click',event=>{
  if(!select.contains(event.target)){panel.hidden=true;trigger.setAttribute('aria-expanded','false');}
 });
 ['min','max'].forEach(side=>{
  const input=document.getElementById('rivals-year-'+side);input.min=min;input.max=max;input.value=side==='min'?min:max;
  input.addEventListener('input',()=>{
   const left=document.getElementById('rivals-year-min'),right=document.getElementById('rivals-year-max');
   if(+left.value>+right.value){if(side==='min')right.value=left.value;else left.value=right.value;}
   rivalsFilterState.minYear=+left.value;rivalsFilterState.maxYear=+right.value;
   document.getElementById('rivals-years-value').textContent=left.value+' – '+right.value;
   renderRivals();
  });
 });
 document.getElementById('rivals-years-value').textContent=min+' – '+max;
 const team=document.getElementById('rivals-team'),opponent=document.getElementById('rivals-opponent');
 team.addEventListener('change',()=>{rivalsFilterState.team=team.value;refreshRivalsOpponents();renderRivalsInsights();});

 refreshRivalsOpponents();
}
function refreshRivalsOpponents(){
 const box=document.getElementById('rivals-opponent');if(!box)return;
 const names=['Flamengo','Vasco','Botafogo','Fluminense'].filter(t=>t!==rivalsFilterState.team);
 rivalsFilterState.opponents=names.slice();
 box.replaceChildren();
 const trigger=document.createElement('button');trigger.type='button';trigger.className='rivals-multi-trigger';trigger.setAttribute('aria-expanded','false');
 const panel=document.createElement('div');panel.className='rivals-multi-panel';panel.hidden=true;
 const update=()=>{trigger.textContent=rivalsFilterState.opponents.length===names.length?'Todos':rivalsFilterState.opponents.length?rivalsFilterState.opponents.join(', '):'Nenhum';};
 const make=(label,all)=>{
   const row=document.createElement('label');const cb=document.createElement('input');cb.type='checkbox';cb.value=label;cb.checked=true;
   row.append(cb,document.createTextNode(label));
   cb.addEventListener('change',()=>{
     if(all){rivalsFilterState.opponents=cb.checked?names.slice():[];}
     else {rivalsFilterState.opponents=cb.checked?[...new Set([...rivalsFilterState.opponents,label])]:rivalsFilterState.opponents.filter(t=>t!==label);}
     panel.querySelectorAll('input').forEach(input=>input.checked=input.value==='Todos'?rivalsFilterState.opponents.length===names.length:rivalsFilterState.opponents.includes(input.value));
     update();renderRivalsInsights();
   });
   panel.append(row);
 };
 make('Todos',true);names.forEach(n=>make(n,false));update();
 trigger.addEventListener('click',()=>{panel.hidden=!panel.hidden;trigger.setAttribute('aria-expanded',String(!panel.hidden));});
 box.append(trigger,panel);
}
function rivalsInsightMatches(){
 const team=rivalsFilterState.team,selected=rivalsFilterState.opponents;
 const items=[];
 Object.values(RIVALS_DATA).forEach(d=>{
  if(d.a!==team&&d.b!==team)return;
  const other=d.a===team?d.b:d.a;
  if(!selected.includes(other))return;
  rivalsFilteredRows(d).forEach((r,i)=>{
   const gf=d.a===team?r[2]:r[3],ga=d.a===team?r[3]:r[2];
   items.push({date:r[0],year:r[1],time:parseRivalsDate(r),gf,ga,opp:other,competition:r[4],result:gf>ga?'V':gf<ga?'D':'E',key:d.a+'-'+d.b+'-'+i});
  });
 });
 if(selected.includes('Fluminense')){
  if(!CLASSICOS_DATA.length){ /* A base principal ainda pode estar carregando. */ }
  CLASSICOS_DATA.forEach((m,i)=>{
   const other=normalizeComparable(m.adv);
   if(other!==normalizeComparable(team)||!Number.isFinite(m.gf)||!Number.isFinite(m.ga))return;
   if(rivalsFilterState.minYear!==null&&m.ano<rivalsFilterState.minYear)return;
   if(rivalsFilterState.maxYear!==null&&m.ano>rivalsFilterState.maxYear)return;
   if(!rivalsCompetitionSelected(m.torneio))return;
   const time=m.timestamp||computeTimestamp(m.data);
   items.push({date:m.data,year:m.ano,time,gf:m.ga,ga:m.gf,opp:'Fluminense',competition:m.torneio,result:m.ga>m.gf?'V':m.ga<m.gf?'D':'E',key:'flu-'+i});
  });
 }
 return items.sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
}
function rivalsLongestStreak(items,allow){
 let current=[],best=[];
 items.forEach(m=>{if(allow(m.result)){current.push(m);if(current.length>best.length)best=current.slice();}else current=[];});
 return best;
}
function renderRivalsInsightList(kind){
 const list=document.getElementById('rivals-'+kind+'-list');if(!list)return;
 list.innerHTML=sharedDetailsHeader();
 (rivalsInsightLists[kind]||[]).forEach(m=>{
  list.insertAdjacentHTML('beforeend',sharedDetailsRow(rivalsFullDate(m),m.opp,m.gf+' × '+m.ga,m.competition,m.result));
 });
 list.hidden=!rivalsInsightOpen[kind];
 const btn=document.getElementById('rivals-'+kind+'-toggle');
 if(btn){btn.textContent=rivalsInsightOpen[kind]?'Ocultar partidas ⌃':'Ver partidas ›';btn.disabled=!(rivalsInsightLists[kind]||[]).length;}
}
function toggleRivalsInsight(kind){rivalsInsightOpen[kind]=!rivalsInsightOpen[kind];renderRivalsInsightList(kind);}
function resetRivalsFilters(){
 rivalsFilterState.competitions=null;
 const all=document.querySelector('#rivals-competition input[value="__all__"]');
 if(all){all.checked=true;all.dispatchEvent(new Event('change',{bubbles:true}));}
 const left=document.getElementById('rivals-year-min'),right=document.getElementById('rivals-year-max');
 if(left&&right){
  left.value=left.min;right.value=right.max;
  rivalsFilterState.minYear=+left.value;rivalsFilterState.maxYear=+right.value;
  const output=document.getElementById('rivals-years-value');
  if(output)output.textContent=left.value+' – '+right.value;
 }
 rivalsFilterState.team='Flamengo';
 const team=document.getElementById('rivals-team');if(team)team.value='Flamengo';
 refreshRivalsOpponents();
 renderRivals();
}
function renderRivalsInsights(){
 const team=rivalsFilterState.team,selected=rivalsFilterState.opponents;
 const others=['Flamengo','Vasco','Botafogo','Fluminense'].filter(t=>t!==team);
 const description=team+' × '+(selected.length===others.length?'Todos':selected.length?selected.join(', '):'Nenhum');
 const selection=document.getElementById('rivals-selection-label');if(selection)selection.textContent=description;
 const matches=rivalsInsightMatches(),recent=matches.slice(-5),wins=rivalsLongestStreak(matches,r=>r==='V'),unbeaten=rivalsLongestStreak(matches,r=>r!=='D');
 rivalsInsightLists={recent,wins,unbeaten};
 const circles=document.getElementById('rivals-recent-circles');if(circles){circles.replaceChildren();recent.forEach(m=>{const el=document.createElement('span');el.className='rivals-result rivals-result-'+m.result;el.textContent=m.result;el.title=m.date+' · '+m.opp+' · '+m.gf+' × '+m.ga;circles.append(el);});if(!recent.length)circles.textContent='Sem partidas no recorte.';}
 const points=recent.reduce((n,m)=>n+(m.result==='V'?3:m.result==='E'?1:0),0);
 const put=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
 const rivalRate=recent.length?Math.round(points/(recent.length*3)*100):null;
 put('rivals-recent-rate',rivalRate!==null?rivalRate+'%':'—');
 const rivalRateEl=document.getElementById('rivals-recent-rate');
 if(rivalRateEl)rivalRateEl.style.color=rivalRate!==null?recentRateColor(rivalRate):'';
 put('rivals-recent-gf',recent.length?recent.reduce((n,m)=>n+m.gf,0):'—');
 put('rivals-recent-ga',recent.length?recent.reduce((n,m)=>n+m.ga,0):'—');
 put('rivals-wins-count',wins.length);put('rivals-unbeaten-count',unbeaten.length);
 put('rivals-wins-period',wins.length?rivalsFullDate(wins[0])+' a '+rivalsFullDate(wins[wins.length-1]):'Nenhuma vitória no recorte');
 put('rivals-unbeaten-period',unbeaten.length?rivalsFullDate(unbeaten[0])+' a '+rivalsFullDate(unbeaten[unbeaten.length-1]):'Nenhuma sequência no recorte');
 put('rivals-unbeaten-breakdown',unbeaten.length?'('+unbeaten.filter(m=>m.result==='V').length+'V / '+unbeaten.filter(m=>m.result==='E').length+'E)':'');
 ['recent','wins','unbeaten'].forEach(renderRivalsInsightList);
}
