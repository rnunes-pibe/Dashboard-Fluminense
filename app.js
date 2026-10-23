const DASHBOARD_VERSION = '3.2.16';

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

function switchTableTab(tab) {
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
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
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
            const x = (mobileOutside && isMobile) ? element.x + 8 : Math.min(element.x + 6, chartArea.right - rightReserve);
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
      ctx.fillStyle = '#A3B8B0';

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
            color: 'rgba(255,255,255,0.7)',
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
  Chart.defaults.color = '#A3B8B0';
  Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.07)';
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
    options: { layout: { padding: { top: 18 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: showLegend, position: 'top', labels: {color: 'rgba(255,255,255,0.7)'} }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { y: { beginAtZero: true, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } } } }
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
        legend: { display: showLegend, position: 'top', labels: { color: 'rgba(255,255,255,0.7)' } },
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
    options: { layout: { padding: { top: 18, left: chartsMobile ? 0 : 6, right: chartsMobile ? 2 : 6 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: showLegend, position: 'top', labels: {color: 'rgba(255,255,255,0.7)'} }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { y: { display: !chartsMobile, beginAtZero: true, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } } } }
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
        legend: { display: showLegend, position: 'top', labels: { color: 'rgba(255,255,255,0.7)' } },
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
          options: { indexAxis: 'y', layout: { padding: { right: chartsMobile ? 46 : 58 } }, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => { let j = ctx.dataset.customCount[ctx.dataIndex]; return ` Média: ${ctx.parsed.x.toLocaleString('pt-BR')} (${j} ${j>1?'jogos':'jogo'})`; } } } }, scales: { x: { display: !chartsMobile, beginAtZero: true, grace: chartsMobile ? '5%' : 0, ticks: { display: false, callback: v => v.toLocaleString('pt-BR') } }, y: { ticks: { display: true, padding: chartsMobile ? 2 : 6 } } } }
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
          ctx.fillStyle = 'rgba(255,255,255,0.88)';
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
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
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
        legend: { position: 'top', labels: { color: 'rgba(255,255,255,0.7)' } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { stacked: false, ticks: { color: 'rgba(255,255,255,0.7)' }, grid: { display: false } },
        y: { beginAtZero: true, grace: chartsMobile ? '20%' : '16%', ticks: { display: false, color: 'rgba(255,255,255,0.7)' }, grid: { color: 'rgba(255,255,255,0.05)' } }
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

function resultBadge(match) {
  const result = getMatchResult(match);
  const styles = {
    V: 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300',
    E: 'result-draw',
    D: 'bg-rose-950/90 border-rose-500/60 text-rose-300'
  };
  if (!result) return `<span class="font-bold text-white">${escapeHtml(match.placar)}</span>`;
  return `<span class="inline-flex items-center gap-2 px-2 py-1 rounded-lg border ${styles[result]} font-sans font-bold whitespace-nowrap"><span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-black/25 text-[10px]">${result}</span><span class="font-mono text-white">${escapeHtml(match.placar)}</span></span>`;
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
    tbody.innerHTML = `<tr><td colspan="12" class="p-8 text-center text-white/40 font-sans">Nenhuma partida encontrada para os filtros selecionados.</td></tr>`;
    document.getElementById("table-pagination").innerHTML = "";
    return;
  }

  tbody.innerHTML = pageItems.map(m => {
    const isHome = m.mando === "Mandante";
    const isAway = m.mando === "Visitante";
    const mandoBadge = isHome ? `<span class="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-sans text-[10px] font-bold border border-emerald-500/40">Mandante</span>` : isAway ? `<span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 font-sans text-[10px] font-bold border border-rose-500/40">Visitante</span>` : `<span class="px-2 py-0.5 rounded bg-amber-950 text-amber-300 font-sans text-[10px] font-bold border border-amber-500/40">Neutro</span>`;
    const sulRate = m.sul ? `${((m.sul / CONFIG.capacidadeSulPagantes) * 100).toFixed(1)}%` : "-";
    const presBadge = m.presente === "Sim" ? `<span class="px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 font-sans text-[10px] font-bold border border-cyan-500/40">Sim</span>` : `<span class="text-white/30">Não</span>`;

    return `<tr class="hover:bg-white/[0.04] transition border-b border-white/5">
      <td class="p-3 text-white/90 whitespace-nowrap">${escapeHtml(m.data || "-")}</td>
      <td class="p-3 text-white/50">${escapeHtml(m.hora || "-")}</td>
      <td class="p-3 font-sans text-[11px] text-white/80 max-w-[170px] truncate" title="${escapeHtml(m.torneio)}">${escapeHtml(m.torneio)}</td>
      <td class="p-3">${mandoBadge}</td>
      <td class="p-3 font-sans font-bold text-white">${escapeHtml(m.adv)}</td>
      <td class="p-3 font-sans text-white/70 max-w-[150px] truncate" title="${escapeHtml(m.estadio)}">${escapeHtml(m.estadio)}</td>
      <td class="p-3 text-center">${resultBadge(m)}</td>
      <td class="p-3 text-right font-bold text-emerald-400">${fmt(m.pub)}</td>
      <td class="p-3 text-right text-rose-300">${fmt(m.pubVis)}</td>
      <td class="p-3 text-right text-cyan-300 font-semibold">${fmt(m.sul)}</td>
      <td class="p-3 text-right text-amber-300 font-bold">${sulRate}</td>
      <td class="p-3 text-center">${presBadge}</td>
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

function updateClassicosChart(data) {
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
          borderColor: '#ffffff', 
          backgroundColor: '#ffffff', 
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
             legend: { position: 'bottom', labels: { color: 'rgba(255,255,255,0.7)', usePointStyle: true, boxWidth: 8 } },
             tooltip: { callbacks: { title: (items) => `Data: ${items[0].label}` } }
         },
         scales: {
             x: { ticks: { maxTicksLimit: 10, color: 'rgba(255,255,255,0.4)' }, grid: { display: false } },
             y: { 
                 grid: { 
                     color: (ctx) => ctx.tick && ctx.tick.value === 0 ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255,255,255,0.05)',
                     lineWidth: (ctx) => ctx.tick && ctx.tick.value === 0 ? 2 : 1
                 }, 
                 ticks: { color: 'rgba(255,255,255,0.6)' }
             }
         }
     }
  });
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
      <td class="p-3 text-white/90">${escapeHtml(c.data)}</td>
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
    'reset-filters': () => resetFilters(),
    'toggle-sem-rivais': () => toggleSemRivais(),
    'reset-classicos-filters': () => resetClassicosFilters(),
    'copy-filtered-url': () => copyFilteredUrl(),
    'export-filtered-csv': () => exportFilteredCsv(),
    'export-classicos-csv': () => exportClassicosFilteredCsv(),
    'navigate-page': () => navigatePage(Number(target.dataset.direction)),
    'sort-catalog': () => sortCatalog(target.dataset.sortScope, target.dataset.sortKey),
    'switch-tab': () => switchTab(target.dataset.tab),
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
  initEventHandlers();
  initChartRecoveryHandlers();
  restoreFiltersFromUrl();
  if (window.lucide) lucide.createIcons();
  fetchLiveGoogleSheet();
}



function renderDashboardVersion() {
  const versionEl = document.getElementById('dashboard-version');
  if (versionEl) versionEl.textContent = `v${DASHBOARD_VERSION}`;
}
document.addEventListener('DOMContentLoaded', initDashboard);
