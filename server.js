const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ORIGIN = 'https://pedidosgoodcompany.com.ar';
const PORT = Number(process.env.PORT || 3100);
const CACHE_MS = 5 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 60 * 1000;
let lastManualRequest = 0;
let syncState = {running:false,startedAt:null,finishedAt:null,success:null,trigger:null,nextScheduledAt:null};
let autoTimer=null;
let cache = { time: 0, products: [], error: null, diagnostic: null };
let pending = null;
let lastDiagnostic = {checkedAt:null, adminCount:null, loadedCount:null, missingFromCatalog:[], extractionErrors:[], salesCheck:{status:'pendiente',note:'La comparación con ventas requiere verificar el listado completo.'}};
const DIAGNOSTIC_FILE = path.join(__dirname,'data','diagnostico.json');
try { const previous=JSON.parse(fs.readFileSync(DIAGNOSTIC_FILE,'utf8'));if(previous&&typeof previous==='object')lastDiagnostic=previous; } catch {}
function saveDiagnostic(){try{fs.mkdirSync(path.dirname(DIAGNOSTIC_FILE),{recursive:true});fs.writeFileSync(DIAGNOSTIC_FILE,JSON.stringify(lastDiagnostic,null,2),'utf8')}catch(e){console.warn('[STOCK] No se pudo guardar diagnóstico:',e.message)}}

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'catalogo.json');
// Cada ciclo consulta las fichas MASTER de TODOS los artículos con STOCK SI.
const normalizeCode = x => String(x || '').replace(/\s+/g, ' ').trim().toUpperCase();
function restoreCache() {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(saved.products)) {
      cache = { time: Number.isFinite(Date.parse(saved.savedAt)) ? Date.parse(saved.savedAt) : 0, products: saved.products, error: null, diagnostic: 'Datos guardados; verificando disponibilidad actual.' };
      console.log('[STOCK] Catálogo guardado recuperado:', cache.products.length);
    }
  } catch (err) { if (err.code !== 'ENOENT') console.warn('[STOCK] No se pudo recuperar catálogo:', err.message); }
}
function saveCache(next) {
  fs.mkdirSync(DATA_DIR, {recursive:true});
  const tmp=CACHE_FILE+'.tmp';
  const backup=CACHE_FILE+'.bak';
  const payload=JSON.stringify({version:2,products:next.products,savedAt:new Date(next.time).toISOString()});
  try {
    fs.writeFileSync(tmp,payload,'utf8');
    const verify=JSON.parse(fs.readFileSync(tmp,'utf8'));
    if (!Array.isArray(verify.products)||verify.products.length!==next.products.length) throw Error('Copia temporal inválida');
    if(fs.existsSync(CACHE_FILE)) fs.copyFileSync(CACHE_FILE,backup);
    fs.renameSync(tmp,CACHE_FILE);
  } catch(e) {
    try{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}catch{}
    throw e;
  }
}

restoreCache();

const abs = (url) => { try { const u = new URL(url, ORIGIN); return u.origin === ORIGIN ? u.href : null; } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser = null;
let context = null;
let authenticated = false;
let authPromise = null;
async function session() {
  if (authPromise) return authPromise;
  authPromise = openAdminSession();
  try { return await authPromise; } finally { authPromise = null; }
}
async function openAdminSession() {
  if (context && authenticated) return context;
  const email = process.env.GC_ADMIN_EMAIL?.trim() || process.env.GC_EMAIL?.trim();
  const password = process.env.GC_ADMIN_PASSWORD || process.env.GC_PASSWORD;
  if (!email || !password) throw Error('Configurá GC_ADMIN_EMAIL y GC_ADMIN_PASSWORD (o GC_EMAIL y GC_PASSWORD) en .env');
  if (!browser) browser = await chromium.launch({headless: true});
  if (context) await context.close();
  context = await browser.newContext({locale:'es-AR',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'});
  const page = await context.newPage();
  const adminUrl = ORIGIN + '/admin/index/productos';
  try {
    await page.goto(adminUrl, {waitUntil:'domcontentloaded',timeout:45000});
    if (await page.locator('#tabla thead th').count()) { authenticated = true; return context; }
    // IMPORTANTE: entrar por /admin, NO por el formulario de clientes de /productos.
    await page.goto(ORIGIN + '/admin', {waitUntil:'domcontentloaded',timeout:45000});
    if (await page.locator('#tabla thead th').count()) { authenticated = true; return context; }
    const userInput = page.locator('input[name="email"], input[name="usuario"], input[name="username"], input[name="user"], input[type="email"], input[id*="email" i], input[id*="usuario" i], input[id*="user" i], input[type="text"]').filter({visible:true}).first();
    const passInput = page.locator('input[type="password"]').filter({visible:true}).first();
    if (!await userInput.count() || !await passInput.count()) {
      throw Error(`No se encontró el formulario de acceso administrativo en ${page.url()}. Enviame una captura de esa pantalla (sin contraseña).`);
    }
    await userInput.fill(email);
    await passInput.fill(password);
    const form = passInput.locator('xpath=ancestor::form[1]');
    if (await form.count()) {
      const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
      if (await submit.count()) await submit.click();
      else await passInput.press('Enter');
    } else {
      const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Ingresar"), button:has-text("Entrar"), button:has-text("Iniciar")').first();
      if (await submit.count()) await submit.click();
      else await passInput.press('Enter');
    }
    // El sitio puede autenticar por POST tradicional o AJAX.
    await page.waitForTimeout(1800);
    await page.goto(adminUrl, {waitUntil:'domcontentloaded',timeout:45000});
    if (!await page.locator('#tabla thead th').count()) {
      throw Error(`El acceso administrativo no mostró la tabla Productos. URL: ${page.url()}. Verificá el usuario administrador en .env y la pantalla de inicio de sesión.`);
    }
    authenticated = true;
    console.log('[STOCK] Acceso administrativo verificado.');
    return context;
  } catch (err) {
    authenticated = false;
    throw err;
  } finally { await page.close(); }
}
// La sesión de administrador determina STOCK. La sesión de cliente permite
// recuperar las fichas completas (incluidas las muestras de colores).
let clientContext = null;
let clientAuthenticated = false;
async function clientSession() {
  if (clientContext && clientAuthenticated) return clientContext;
  const email = process.env.GC_EMAIL?.trim();
  const password = process.env.GC_PASSWORD;
  if (!email || !password) throw Error('Para recuperar los colores, configurá GC_EMAIL y GC_PASSWORD (cuenta de cliente) en .env, además de GC_ADMIN_EMAIL y GC_ADMIN_PASSWORD.');
  if (!browser) browser = await chromium.launch({headless: true});
  if (clientContext) await clientContext.close();
  clientContext = await browser.newContext({locale:'es-AR',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'});
  const page = await clientContext.newPage();
  try {
    await page.goto(ORIGIN + '/productos', {waitUntil:'domcontentloaded',timeout:45000});
    const loginLink = page.locator('a[onclick*="openModal"]').first();
    if (await loginLink.count()) await loginLink.click();
    const emailInput = page.locator('#singin-email');
    if (!await emailInput.count()) throw Error('No apareció el formulario de cliente necesario para consultar colores.');
    await emailInput.fill(email);
    await page.locator('#singin-password').fill(password);
    await page.locator('button[onclick*="loguearUsuario"]').click();
    await page.waitForTimeout(3000);
    clientAuthenticated = true;
    console.log('[STOCK] Sesión de cliente iniciada para obtener detalles y colores.');
    return clientContext;
  } catch (err) {
    clientAuthenticated = false;
    throw err;
  } finally { await page.close(); }
}
async function getPage(route) {
  const ctx = await clientSession();
  const response = await ctx.request.get(ORIGIN + route, {timeout:30000,failOnStatusCode:false});
  if (!response.ok()) throw Error(`HTTP ${response.status()} en ${route}`);
  const html = await response.text();
  if (!html.includes('product')) throw Error(`Respuesta HTML inesperada en ${route}`);
  return cheerio.load(html);
}

function auditCode(value) {
  // El descuento forma parte del nombre comercial, no del código del artículo.
  return normalizeCode(value).replace(/\s+\d+(?:[.,]\d+)?\s*%\s*OFF\b.*$/i, '').trim();
}
function cardList($) {
  const cards=[];
  $('.product.product-7').each((_,node)=>{
    const el=$(node);
    const href=el.find('figure a[href*="/productos/detalle/"]').first().attr('href')||'';
    const raw=el.find('.product-title').first().text().replace(/\s+/g,' ').trim();
    cards.push({raw,href,code:auditCode(raw)});
  });
  return cards;
}
async function checkSalesListing(allowed) {
  const codes=new Map(), visited=new Set(), pages=[], unidentified=[];
  const queue=['/productos/todos/1','/productos/todos/2','/productos/todos/3'];
  let expected=null, issue=null;
  const checkedAt=new Date().toISOString();
  // Solo paginación general. Nunca recorrer filtros por color: repiten artículos.
  while(queue.length && pages.length<30){
    const route=queue.shift();
    if(visited.has(route))continue;
    visited.add(route);
    let $;
    try{$=await getPage(route)}catch(e){issue=`Error al leer ${route}: ${e.message}`;break}
    const cards=cardList($);
    if(!cards.length){issue=`Sin tarjetas reconocibles en ${route}`;break}
    const body=$('body').text().replace(/\s+/g,' ');
    const match=body.match(/Mostrando\s+\d+\s+de\s+(\d+)\s+productos/i)
      ||body.match(/(?:Total(?:\s+de)?\s+productos|Productos\s+encontrados)\s*:?\s*(\d+)/i);
    if(match)expected=Number(match[1]);
    let added=0;
    for(const card of cards){
      if(!card.raw||!card.href||!card.code){
        unidentified.push({page:route,title:card.raw||'(sin título)',href:card.href||'',reason:'Tarjeta sin título, código o enlace'});
        continue;
      }
      if(!codes.has(card.code)){codes.set(card.code,{title:card.raw,href:card.href,page:route});added++}
    }
    pages.push({route,items:cards.length,newCodes:added});
    $('a[href]').each((_,el)=>{
      const href=$(el).attr('href')||'';
      let u;
      try{u=new URL(href,ORIGIN)}catch{return}
      if(u.origin!==new URL(ORIGIN).origin)return;
      if(!/^\/productos\/todos(?:\/\d+)?\/?$/i.test(u.pathname) || u.search)return;
      const next=u.pathname.replace(/\/$/,'');
      if(!visited.has(next)&&!queue.includes(next))queue.push(next);
    });
    if(expected!==null && codes.size>=expected && unidentified.length===0)break;
  }
  const sort=(a,b)=>a.localeCompare(b,'es',{numeric:true});
  // Normalizar ambos lados; preservar el código original del catálogo para mostrarlo.
  const reference=[...allowed.keys()].map(original=>({original,canonical:auditCode(original)})).sort((a,b)=>sort(a.canonical,b.canonical));
  const matched=reference.filter(x=>codes.has(x.canonical));
  const absent=reference.filter(x=>!codes.has(x.canonical));
  const complete=!issue&&expected!==null&&codes.size===expected&&unidentified.length===0;
  const note=issue||(expected===null?'No se obtuvo un total verificable del catálogo de ventas.':
    !complete?`Ventas informa ${expected} productos, pero se identificaron ${codes.size} códigos únicos. No es seguro declarar ausencias.`:
    'Se identificaron todos los productos informados por ventas.');
  const detail=x=>({code:x.original,canonicalCode:x.canonical,referenceStatus:'STOCK SI',salesStatus:codes.has(x.canonical)?'ENCONTRADO':complete?'NO ENCONTRADO':'NO VERIFICADO',salesTitle:codes.get(x.canonical)?.title||null,salesUrl:codes.get(x.canonical)?.href||null});
  return {
    status:complete?'verificado':'incompleto',checkedAt,publicCount:codes.size,
    expectedPublicCount:expected,pagesChecked:pages.length,pages,
    matchCount:matched.length,matchedArticles:matched.map(detail),
    missingArticles:complete?absent.map(detail):[],
    unverifiedArticles:complete?[]:absent.map(detail),
    unidentifiedSalesProducts:unidentified,repeatedSalesCodes:[],
    missingFromSales:complete?absent.map(x=>x.original):[],possibleMissingFromSales:complete?[]:absent.map(x=>x.original),
    note,warning:complete?null:'Lectura incompleta: los artículos no encontrados son NO VERIFICADOS, no faltantes confirmados.'
  };
}

function parseDetail($, card) {
  const raw = $('.product-content').first().text().replace(/\s+/g, ' ').trim();
  const measureStart = raw.search(/Medidas/i);
  const description = (measureStart >= 0 ? raw.slice(0, measureStart) : raw).trim();
  const measurements = {};
  for (const [key, regex] of Object.entries({ alto: /Alto\.?\s*(\d+(?:[.,]\d+)?)\s*cm/i, ancho: /Ancho\.?\s*(\d+(?:[.,]\d+)?)\s*cm/i, profundidad: /Profundidad\.?\s*(\d+(?:[.,]\d+)?)\s*cm/i })) {
    const m = raw.match(regex); if (m) measurements[key] = m[1] + ' cm';
  }
  const colors = [];
  const colorImages = [];
  $('.product-details-color').each((_, img) => {
    const name = $(img).attr('alt')?.trim();
    if (name && !colors.includes(name)) {
      colors.push(name);
      colorImages.push({ name, image: abs($(img).attr('src')) });
    }
  });
  // El precio válido está dentro de .product-details, no en el aviso junto a la fotografía.
  const priceRaw = $('.product-details .product-price').first().text().replace(/\s+/g, ' ').trim();
  const priceMatch = priceRaw.match(/\$\s*[\d.,]+/);
  const price = priceMatch ? priceMatch[0].replace(/\s+/g, '') : null;
  // Los importes de OFERTAS están escritos en la descripción del producto.
  // Leerlos por etiqueta (no calcular descuentos, ni asumir precios).
  const normalizeMoney = value => value ? '$' + value.replace(/\s+/g, '').replace(/^\$/, '') : null;
  const normalMatch = raw.match(/(?:["“”']?\s*Precio\s+Normal\s*["“”']?\s*[:：-]?\s*)\$?\s*([\d][\d.,]*)/i);
  const discountMatch = raw.match(/(?:["“”']?\s*Precio\s*C\s*\/?\s*dto\s*["“”']?\s*[:：-]?\s*)\$?\s*([\d][\d.,]*)/i);
  const offerPrices = normalMatch && discountMatch ? {
    normal: normalizeMoney(normalMatch[1]),
    discounted: normalizeMoney(discountMatch[1])
  } : null;
  const line = $('.product-details h5.product-title').first().text().trim();
  const image = abs($('meta[property="og:image"]').attr('content')) || card.image;
  return { ...card, description, measurements, colors, colorImages, price, line, image, offerPrices };
}
// Fuente de verdad: listado administrativo, sin filtros por categoría.
async function adminStock() {
  const ctx = await session();
  const page = await ctx.newPage();
  try {
    const response = await page.goto(ORIGIN + '/admin/index/productos', {waitUntil:'domcontentloaded',timeout:45000});
    if (!response?.ok()) throw Error('No se pudo abrir la administración de Productos');
    // La URL administrativa es la fuente obligatoria; detectar login en vez de esperar 20s sin explicación.
    const table = page.locator('#tabla');
    if (!(await table.count())) {
      authenticated = false;
      const url = page.url();
      const title = await page.title().catch(() => '');
      throw Error(`No se pudo acceder al listado administrativo. URL actual: ${url}. Título: ${title}. Comprobá que la cuenta tenga acceso de administrador.`);
    }
    await page.locator('#tabla tbody tr').first().waitFor({timeout:15000});
    const headers = await page.locator('#tabla thead th').allTextContents();
    const cols = headers.map(x => x.trim().toUpperCase());
    const nameIndex = cols.findIndex(x => x === 'NOMBRE');
    const stockIndex = cols.findIndex(x => x === 'STOCK');
    const categoryIndex = cols.findIndex(x => x === 'CATEGORIA' || x === 'CATEGORÍA');
    const motivoIndex = cols.findIndex(x => x === 'MOTIVO');
    if (nameIndex < 0 || stockIndex < 0) throw Error('No se identificaron las columnas NOMBRE y STOCK en administración');
    // DataTables carga inicialmente 100 filas: cambiar a "Todos" antes de leer.
    const selector = page.locator('#tabla_length select');
    if (await selector.count()) {
      const options = await selector.locator('option').evaluateAll(els => els.map(el => ({value:el.value,text:el.textContent.trim()})));
      const all = options.find(x => x.value === '-1' || /todos/i.test(x.text));
      if (!all) throw Error('No se encontró opción Todos en listado administrativo');
      await selector.selectOption(all.value);
      await page.waitForTimeout(500);
    }
    const info = await page.locator('#tabla_info').textContent().catch(() => '');
    const records = await page.locator('#tabla tbody tr').evaluateAll((rows, indices) => rows.map(row => {
      const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
      const colorButton = row.querySelector('button[onclick*="color("]');
      const id = colorButton?.getAttribute('onclick')?.match(/color\((\d+)\)/)?.[1] || null;
      const actionCell = row.querySelectorAll('td')[row.querySelectorAll('td').length - 1];
      const editLink = actionCell?.querySelector('a[href*="adminproductos/editar/"]')?.getAttribute('href') || '';
      const editOnclick = [...(actionCell?.querySelectorAll('[onclick]') || [])].map(x=>x.getAttribute('onclick')||'').find(x=>/editar/i.test(x)) || '';
      const editId = editLink.match(/adminproductos\/editar\/(\d+)/)?.[1] || editOnclick.match(/(?:editar\w*|edit)\s*\(\s*['"]?(\d+)/i)?.[1] || id;
      return { code: cells[indices[0]] || '', stock: (cells[indices[1]] || '').toUpperCase(), category: indices[2] >= 0 ? (cells[indices[2]] || '') : '', motivo: indices[3] >= 0 ? (cells[indices[3]] || '') : '', id, editId };
    }), [nameIndex, stockIndex, categoryIndex, motivoIndex]);
    const totalMatch = info?.match(/(?:total de|of)\s+(\d+)\s+(?:registros|entries)/i);
    if (totalMatch && records.length !== Number(totalMatch[1])) throw Error(`Listado administrativo incompleto: ${records.length} de ${totalMatch[1]}`);
    if (!records.length || records.some(x => !x.code || !['SI','NO'].includes(x.stock))) throw Error('Administración devolvió filas vacías o stock inválido');
    const allowed = new Map(records.filter(x => x.stock === 'SI').map(x => [x.code.replace(/\s+/g,' ').trim().toUpperCase(), {id:x.id,editId:x.editId,category:x.category,motivo:x.motivo}]));
    if ([...allowed.values()].some(x => !x.id || !x.editId)) throw Error('No se pudieron identificar los enlaces del editor de colores');
    console.log(`[STOCK] Administración: ${records.length} artículos; ${allowed.size} con STOCK = SI`);
    return allowed;
  } finally { await page.close(); }
}

// Leer los colores directamente del editor administrativo del artículo.
// El stock general determina qué artículos aparecen; el stock de color determina qué variantes se muestran.
async function adminColors(id) {
  const ctx = await session();
  let lastError;
  // DataTables puede devolver una fila transitoria ("Procesando..." / "Cargando...")
  // en vez de los registros reales. Reintentar sin tocar el estado del ADMIN.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await ctx.newPage();
    try {
      const route = '/admincolor/listado/' + encodeURIComponent(id);
      const response = await page.goto(ORIGIN + route, {waitUntil:'domcontentloaded',timeout:45000});
      if (!response?.ok()) throw Error('HTTP ' + (response?.status() || 'sin respuesta') + ' en editor de colores ID ' + id);
      const table = page.locator('#tabla');
      if (!page.url().includes('/admincolor/listado/')) {
        authenticated = false;
        throw Error('Sesión administrativa vencida o acceso denegado; redirigido a ' + page.url());
      }
      await table.waitFor({state:'visible',timeout:15000});
      const cols = (await table.locator('thead tr').first().locator('th').allTextContents())
        .map(x => x.replace(/\s+/g,' ').trim().toUpperCase());
      const detailIndex = cols.findIndex(x => x === 'DETALLE');
      const colorIndex = cols.findIndex(x => x === 'COLOR');
      const stockIndex = cols.findIndex(x => x === 'STOCK');
      if (stockIndex < 0 || (detailIndex < 0 && colorIndex < 0))
        throw Error('Columnas de colores inesperadas ID ' + id + ': ' + cols.join(', '));
      const selector = page.locator('#tabla_length select');
      if (await selector.count()) {
        const options = await selector.locator('option').evaluateAll(els => els.map(x => ({value:x.value,text:x.textContent.trim()})));
        const all = options.find(x => x.value === '-1' || /todos/i.test(x.text));
        if (all) await selector.selectOption(all.value);
      }
      // Esperar a que termine el renderizado de DataTables, no solo a que exista un <tr>.
      const deadline = Date.now() + 12000;
      let records = [], invalid = [];
      do {
        const state = await page.evaluate(({detailIndex,colorIndex,stockIndex}) => {
          const rows = [...document.querySelectorAll('#tabla tbody tr')];
          const records = rows.map(row => {
            const cells = [...row.querySelectorAll('td')];
            const name = (cells[detailIndex]?.textContent || cells[colorIndex]?.textContent || '').replace(/\s+/g,' ').trim();
            const stock = (cells[stockIndex]?.textContent || '').replace(/\s+/g,' ').trim().toUpperCase();
            const img = cells[colorIndex]?.querySelector('img')?.getAttribute('src') || null;
            return {name,stock,img,cellCount:cells.length};
          });
          const processing = !!document.querySelector('#tabla_processing:not([style*="display: none"])');
          const info = document.querySelector('#tabla_info')?.textContent || '';
          return {records,processing,info};
        }, {detailIndex,colorIndex,stockIndex});
        records = state.records;
        invalid = records.filter(x => !x.name || !['SI','NO'].includes(x.stock));
        const empty = records.length === 1 && records[0].cellCount === 1;
        if (!state.processing && records.length && !invalid.length && !empty) {
          // Evitar aceptar una tabla parcialmente cargada: comparar con total de DataTables.
          const match = state.info.match(/(?:total de|of)\s+(\d+)\s+(?:registros|entries)/i);
          if (!match || records.length === Number(match[1])) {
            return records.filter(x => x.stock === 'SI').map(x => ({name:x.name,image:abs(x.img)}));
          }
        }
        await page.waitForTimeout(500);
      } while (Date.now() < deadline);
      throw Error('Tabla incompleta o vacía sin confirmación ID ' + id + ' (' + records.length + ' filas; inválidas: ' + invalid.map(x => JSON.stringify(x)).slice(0,2).join('; ') + ')');
    } catch (err) {
      lastError = err;
      console.warn('[STOCK] Colores ID ' + id + ', intento ' + attempt + '/3: ' + err.message);
    } finally { await page.close(); }
    if (attempt < 3) await sleep(attempt * 1200);
  }
  throw Error('No se pudieron verificar colores ID ' + id + ' tras 3 intentos: ' + lastError.message);
}

// La ficha administrativa es la fuente principal de fotos, descripción y precio.
// No se usa el campo MOSTRAR para filtrar productos.
async function adminDetail(id, expectedCode) {
  const ctx = await session();
  const page = await ctx.newPage();
  try {
    const response = await page.goto(ORIGIN + '/adminproductos/editar/' + encodeURIComponent(id), {waitUntil:'domcontentloaded',timeout:45000});
    if (!response?.ok() || !/adminproductos\/editar\//.test(page.url())) { authenticated = false; throw Error('No se pudo abrir EDITAR PRODUCTO ID '+id+'; URL: '+page.url()); }
    // El primer input del editor es #accion (type=hidden): nunca será visible.
    // Esperar a que exista un campo editable real, no el input oculto.
    await page.locator('input:not([type="hidden"]):not([type="file"]), textarea, select').first().waitFor({state:'attached',timeout:12000});
    // Dar tiempo a que se inicialice el editor enriquecido después de DOMContentLoaded.
    await page.waitForTimeout(900);
    const data = await page.evaluate(() => {
      const norm = s => (s||'').replace(/\s+/g,' ').trim();
      const labels = [...document.querySelectorAll('label')];
      const field = key => {
        const label = labels.find(l => norm(l.textContent).replace(/\*/g,'').replace(/:$/,'').toLowerCase() === key.toLowerCase());
        if (label) {
          const forId = label.getAttribute('for');
          if (forId && document.getElementById(forId)) return document.getElementById(forId);
          const parent = label.closest('.form-group, .form-floating, .col-md-12, .col-sm-12') || label.parentElement;
          const el = parent?.querySelector('input, select, textarea');
          if (el) return el;
          const sibling = label.nextElementSibling;
          if (sibling?.matches('input,select,textarea')) return sibling;
        }
        return [...document.querySelectorAll('input,select,textarea')].find(e => [e.name,e.id].some(v => v && v.toLowerCase().includes(key.toLowerCase().replace(/\s+/g,''))));
      };
      const val = key => {
        const e = field(key);
        if (!e) return '';
        return e.tagName === 'SELECT' ? norm(e.selectedOptions?.[0]?.textContent || e.value) : norm(e.value);
      };
      // Los editores enriquecidos (Summernote / TinyMCE / CKEditor) pueden
      // mantener el textarea original vacío u oculto mientras el texto real
      // está en un contenedor contenteditable o dentro de un iframe.
      const descriptionField = field('Descripción') || document.querySelector('textarea[name*="descripcion" i],textarea[id*="descripcion" i]');
      const candidates = [];
      const add = (html, source) => {
        if (!html || !String(html).trim()) return;
        const el = document.createElement('div');
        el.innerHTML = String(html);
        const txt = norm(el.textContent || el.innerText || '');
        if (txt) candidates.push({html:String(html),text:txt,source});
      };
      // Primero los editores visibles, sin confundirlos con la barra de herramientas.
      for (const el of document.querySelectorAll('.note-editable, .ck-editor__editable, .ql-editor, .fr-element, .tox-edit-area [contenteditable="true"], [contenteditable="true"][role="textbox"]')) {
        add(el.innerHTML, 'editor-visible');
      }
      // TinyMCE y otros editores renderizan dentro de un iframe del mismo dominio.
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          const doc = frame.contentDocument;
          if (doc?.body && (frame.closest('.tox, .mce-tinymce, .cke, .form-group') || /editor|description|descripcion|tiny|mce|cke/i.test(frame.id+' '+frame.name+' '+frame.className))) {
            add(doc.body.innerHTML, 'iframe-editor');
          }
        } catch (_) { /* iframe externo: no corresponde leerlo */ }
      }
      // También aceptar el valor original cuando el editor lo sincroniza.
      if (descriptionField) add(descriptionField.value, 'campo-descripcion');
      for (const el of document.querySelectorAll('textarea[name*="descrip" i], textarea[id*="descrip" i], [contenteditable="true"][id*="descrip" i], [contenteditable="true"][class*="descrip" i]')) {
        add(el.matches('textarea') ? el.value : el.innerHTML, 'descripcion-identificada');
      }
      // La ficha solo tiene un editor de descripción; escoger el contenido
      // más completo evita seleccionar un textarea vacío o una vista parcial.
      candidates.sort((a,b) => b.text.length - a.text.length);
      const descriptionHTML = candidates[0]?.html || '';
      const descriptionText = candidates[0]?.text || '';
      const images = [...document.querySelectorAll('img')].map(img=>({src:img.currentSrc||img.src||'',width:img.naturalWidth||0,height:img.naturalHeight||0,alt:img.alt||''})).filter(x=>x.src && !/logo|avatar|user|icon|favicon/i.test(x.src));
      images.sort((a,b)=>b.width*b.height-a.width*a.height);
      return {name:val('Nombre'),motivo:val('Motivo'),category:val('Categoría'),descriptionHTML,descriptionText,price:val('Precio AR$')||val('Precio'),images};
    });
    if (!data.descriptionText) throw Error('Descripción vacía en editor MASTER ID '+id+'; se conserva la ficha anterior para evitar borrar datos');
    if (!data.name || normalizeCode(data.name)!==normalizeCode(expectedCode)) throw Error('Ficha ID '+id+' no corresponde a '+expectedCode+' (recibido: '+data.name+')');
    if (!data.price) throw Error('Sin precio en EDITAR PRODUCTO ID '+id);
    const raw = data.descriptionText.replace(/\s+/g, ' ').trim();
    const measurements = {};
    const measureRegex = /(?:Alto|Ancho|Profundidad)\.?\s*[:：-]?\s*\d+(?:[.,]\d+)?\s*cm/gi;
    for (const [key,re] of Object.entries({
      alto:/Alto\.?\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*cm/i,
      ancho:/Ancho\.?\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*cm/i,
      profundidad:/Profundidad\.?\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*cm/i
    })) {
      const m=raw.match(re); if(m) measurements[key]=m[1]+' cm';
    }
    // Quitar medidas SOLO de la descripción comercial; conservarlas en measurements.
    let description = raw;
    if (Object.keys(measurements).length) {
      description = description.replace(measureRegex, ' ')
        .replace(/\bMedidas\b/gi, ' ')
        .replace(/\s+/g,' ').trim();
    }
    // MASTER usa etiquetas entre comillas: "Precio Normal" $ 26.250
    // y "Precio C/ dto " $ 18.375. Las comillas no deben impedir el reconocimiento.
    const normal = raw.match(/['"“”]?\s*Precio\s+Normal\s*['"“”]?\s*[:：=-]?\s*\$?\s*([\d][\d.,]*)/i);
    const discounted = raw.match(/['"“”]?\s*Precio\s*(?:C\s*\/\s*dto\.?|con\s*(?:descuento|dto\.?))\s*['"“”]?\s*[:：=-]?\s*\$?\s*([\d][\d.,]*)/i);
    const offerPrices = normal && discounted ? {normal:'$'+normal[1],discounted:'$'+discounted[1]} : null;
    // Eliminar etiquetas e importes promocionales del texto descriptivo.
    // El precio anterior y el rebajado se presentan en la franja de OFERTAS del visor.
    if (offerPrices) {
      description = description
        .replace(/['"“”]?\s*Precio\s+Normal\s*['"“”]?\s*[:：=-]?\s*\$?\s*[\d][\d.,]*/gi, ' ')
        .replace(/['"“”]?\s*Precio\s*(?:C\s*\/\s*dto\.?|con\s*(?:descuento|dto\.?))\s*['"“”]?\s*[:：=-]?\s*\$?\s*[\d][\d.,]*/gi, ' ')
        .replace(/\s+/g, ' ').trim();
    }
    const price='$'+String(data.price).replace(/[^\d.,]/g,'');
    const image = data.images.map(x=>abs(x.src)).find(Boolean) || null;
    if (!image) throw Error('No se encontró imagen principal en EDITAR PRODUCTO ID '+id);
    return {code:data.name,href:null,category:data.category,image,line:data.motivo,description,measurements,price,offerPrices,colors:[],colorImages:[],_publicColorImages:[]};
  } finally { await page.close(); }
}

async function load() {
  console.log('[STOCK] Verificando stock administrativo...');
  // La fuente administrativa SI/NO siempre se verifica antes de publicar cambios.
  const allowed = await adminStock();
  // La consulta pública es un diagnóstico independiente: nunca frena la sincronización de ADMIN.
  const salesCheck={status:'pendiente',checkedAt:new Date().toISOString(),note:'El control de ventas se ejecuta después de guardar el catálogo.'};
  const oldByCode = new Map(cache.products.map(p => [normalizeCode(p.code), p]));
  const allowedCodes = new Set(allowed.keys());
  const retained = new Map();
  const failures = [];
  const now = Date.now();
  // Conservar temporalmente solo artículos cuyo STOCK SI está confirmado.
  for (const [code, item] of oldByCode) {
    if (allowedCodes.has(code)) retained.set(code, { ...item });
  }

  // Sin dependencia del listado público: cada artículo proviene del MASTER.
  const jobs = [...allowed].map(([code,ids]) => ({code,id:ids.id,editId:ids.editId,category:ids.category,motivo:ids.motivo,old:retained.get(code)}));
  // Tres trabajadores simultáneos: reduce el tiempo de sincronización sin
  // saturar el panel administrativo con demasiadas consultas concurrentes.
  const workers = 3;
  let cursor=0;
  async function worker() {
    while (cursor < jobs.length) {
      const {code,id,editId,category,motivo,old} = jobs[cursor++];
      try {
        // Sólo recuperar detalles completos para nuevos artículos o revisiones periódicas.
        const detailDue = true; // Precio, imagen, descripción y medidas: verificar en cada actualización.
        let item = old ? {...old} : null;
        if (detailDue) {
          try {
            item = await adminDetail(editId,code);
            item._detailCheckedAt = now;
            if (old) {
              item.colors = old.colors;
              item.colorImages = old.colorImages;
            }
          } catch (e) {
            failures.push('Ficha MASTER '+code+': '+e.message);
            if (!old) continue;
            item = {...old};
          }
        }
        if (!item) continue;
        // Priorizar las columnas reales del listado administrativo MASTER.
        // También corrige categorías antiguas guardadas en caché sin esperar la ficha.
        if (category) item.category = category;
        if (motivo) item.line = motivo;
        // Los colores se verifican SIEMPRE, incluso cuando no cambió la ficha.
        try {
          const available = await adminColors(id);
          const publicImages = new Map((item._publicColorImages?.length ? item._publicColorImages : item.colorImages || []).map(c =>
            [c.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase(), c.image]));
          // Cero colores es válido si ADMIN confirma que no hay variantes con stock SI.
          item.colors = [...new Set(available.map(c=>c.name))];
          item.colorImages = available.map(c => ({
            name:c.name,
            image:c.image || null
          }));
        } catch (e) {
          failures.push('Colores '+code+': '+e.message);
          if (!old) continue;
          item.colors = old.colors;
          item.colorImages = old.colorImages;
        }
        retained.set(code,item);
      } catch (e) {
        failures.push('Artículo '+code+': '+e.message);
      }
      await sleep(100);
    }
  }
  await Promise.all(Array.from({length:workers}, () => worker()));
  const changes=[];
  const fields=['image','price','description','measurements','offerPrices','category','line','colors','colorImages'];
  for(const [code,item] of retained){
    const previous=oldByCode.get(code);
    if(!previous){changes.push({code,fields:['nuevo']});continue;}
    const altered=fields.filter(key=>JSON.stringify(previous[key]??null)!==JSON.stringify(item[key]??null));
    if(altered.length)changes.push({code,fields:altered});
  }
  const removed=[...oldByCode.keys()].filter(code=>!allowedCodes.has(code));
  lastDiagnostic = {
    checkedAt: new Date().toISOString(),
    adminCount: allowed.size,
    loadedCount: retained.size,
    missingFromCatalog: [...allowed.keys()].filter(code => !retained.has(code)),
    extractionErrors: failures,
    changedCount:changes.length,
    changedArticles:changes,
    removedArticles:removed,
    unchangedCount:retained.size-changes.length,
    salesCheck
  };
  lastDiagnostic = {...lastDiagnostic, publishedCount:cache.products.length, synchronizationStatus:failures.length?'incompleta':'completa', note:failures.length?'Se conserva el último catálogo válido; los resultados parciales no se publican.':'La verificación ADMIN terminó correctamente.'};
  saveDiagnostic();
  console.log(`[STOCK DIAGNÓSTICO] ADMIN SI: ${allowed.size}; recuperados: ${retained.size}; faltantes: ${lastDiagnostic.missingFromCatalog.length}; errores: ${failures.length}`);
  const products = [...retained.values()].sort((a,b)=>{
    const imported=x=>/IMPORTAD|JENBACH/i.test((x.line||'')+' '+(x.category||''))?1:0;
    return imported(a)-imported(b)||a.code.localeCompare(b.code,'es',{numeric:true});
  });
  if (!products.length && allowed.size) throw Error('No se pudieron verificar artículos disponibles. '+(failures[0]||''));
  if (failures.length) throw Error('Sincronización incompleta ('+failures.length+' errores). No se publicaron cambios parciales. '+failures[0]);
  console.log(`[STOCK] ${products.length} artículos; ${failures.length} advertencias; fuente ADMIN MASTER.`);
  return {time:now,products,error:failures.length?`${failures.length} consultas con advertencia. ${failures[0]}`:null,diagnostic:null};
}
async function refresh(trigger="automatica") {
  if(pending)return pending;
  syncState={...syncState,running:true,startedAt:new Date().toISOString(),finishedAt:null,success:null,trigger,nextScheduledAt:null};
  pending=(async()=>{
    try{
      const next=await load();
      // Guardar y verificar la copia ANTES de publicar en memoria o informar éxito.
      saveCache(next);
      cache=next;
      lastDiagnostic.publishedCount=next.products.length;
      lastDiagnostic.synchronizationStatus='completa';
      lastDiagnostic.note='ADMIN completo y catálogo guardado correctamente. Control de ventas independiente.';
      syncState={...syncState,running:false,finishedAt:new Date().toISOString(),success:true};
      saveDiagnostic();
      console.log(`[STOCK] Copia guardada. ${next.products.length} artículos; ${lastDiagnostic.changedCount} modificados; ${lastDiagnostic.unchangedCount} sin cambios; ${lastDiagnostic.removedArticles.length} retirados.`);
      // La web de ventas puede fallar o demorar; no afecta el resultado de ADMIN.
      lastDiagnostic.salesCheck={status:"pendiente",checkedAt:new Date().toISOString(),note:"Comprobando el listado de ventas después de guardar el catálogo."};
      saveDiagnostic();
      if(process.env.GC_AUDIT_ONLY!=='1')void (async()=>{
        try{
          const allowed=new Map(next.products.map(p=>[normalizeCode(p.code),true]));
          lastDiagnostic.salesCheck=await checkSalesListing(allowed);
          if(lastDiagnostic.salesCheck.status!=='verificado'){
            console.warn('[STOCK VENTAS] Comparación incompleta:',lastDiagnostic.salesCheck.note);
            console.warn('[STOCK VENTAS] POSIBLES faltantes (sin confirmar):',lastDiagnostic.salesCheck.possibleMissingFromSales.join(', ')||'Ninguno');
          }else console.log('[STOCK VENTAS] Faltantes confirmados:',lastDiagnostic.salesCheck.missingFromSales.join(', ')||'Ninguno');
        }catch(e){
          lastDiagnostic.salesCheck={status:'error',checkedAt:new Date().toISOString(),missingFromSales:[],note:'No se pudo completar comparación pública: '+e.message};
          console.warn('[STOCK VENTAS]',e.message);
        }
        saveDiagnostic();
      })();
      return cache;
    }catch(e){
      console.error('[STOCK ERROR GENERAL]',e.stack||e.message);
      syncState={...syncState,running:false,finishedAt:new Date().toISOString(),success:false};
      cache.error='No se pudo verificar el stock actual: '+e.message;
      cache.diagnostic='Datos de última consulta válida, pueden estar desactualizados.';
      lastDiagnostic.synchronizationStatus='incompleta';
      lastDiagnostic.note='Se conserva la última copia válida. '+e.message;
      saveDiagnostic();
      return cache;
    }
  })().finally(()=>{pending=null; scheduleNextAutoRefresh();});
  return pending;
}
// Un único reloj de 15 minutos DESPUÉS de finalizar cada intento.
// No saltea ciclos cuando una lectura ADMIN tarda más de 15 minutos.
let lastRefreshAttempt = 0;
function scheduleNextAutoRefresh() {
  if(autoTimer)clearTimeout(autoTimer);
  const next=Date.now()+CACHE_MS;
  syncState.nextScheduledAt=new Date(next).toISOString();
  autoTimer=setTimeout(()=>startBackgroundRefresh('automatica'),CACHE_MS);
  autoTimer.unref();
  console.log('[STOCK AUTO] Próxima revisión:',syncState.nextScheduledAt);
}
function startBackgroundRefresh(trigger='automatica') {
  if(pending) {
    console.log('[STOCK] Ya hay sincronización en curso; no se inicia otra.');
    return false;
  }
  if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}
  lastRefreshAttempt=Date.now();
  syncState.nextScheduledAt=null;
  console.log('[STOCK] Inicio de actualización:',trigger,new Date().toISOString());
  void refresh(trigger).catch(err=>console.error('[STOCK] Actualización:',err));
  return true;
}
if(process.env.GC_AUDIT_ONLY!=='1')setImmediate(()=>startBackgroundRefresh('inicio'));


// Informe de impresión A4: exclusivamente artículo y colores disponibles.
const htmlEscape = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function printColorsHtml(products) {
  const sortCodes=(a,b)=>String(a.code||'').localeCompare(String(b.code||''),'es',{numeric:true});
  const national=[],imported=new Map(),offers=[];
  for(const p of products){
    const line=String(p.line||'').toUpperCase(),cat=String(p.category||'').trim();
    const joined=(line+' '+cat).toUpperCase();
    const isImported=/IMPORTAD|JENBACH|\bOFERTAS?\b/.test(joined);
    if(!isImported){national.push(p);continue;}
    // OFERTAS: un único apartado para promociones importadas, incluidas JENBACH.
    // Usar tanto la clasificación administrativa como los precios promocionales.
    const isOffer=/\bOFERTAS?\b/i.test(joined) || !!(p.offerPrices?.discounted);
    if(isOffer){offers.push(p);continue;}
    const jenbach=/JENBACH/i.test(joined);
    let section=cat.toUpperCase()
      .replace(/\bIMPORTAD[AO]S?\b/g,'')
      .replace(/\bOFERTAS?\b/g,'')
      .replace(/[—–-]+/g,' ')
      .replace(/\s+/g,' ').trim();
    if(jenbach)section='JENBACH';
    else if(!section)section='OTROS IMPORTADOS';
    if(!imported.has(section))imported.set(section,[]);
    imported.get(section).push(p);
  }
  const colors=p=>[...new Set((Array.isArray(p.colors)?p.colors:[]).map(c=>typeof c==='string'?c.trim():String(c?.name||c?.color||'').trim()).filter(Boolean))];
  const COLOR_COLUMNS=10;
  const table=(title,items)=>{
    const rows=items.sort(sortCodes).map(p=>{
      const available=colors(p);
      const cells=Array.from({length:COLOR_COLUMNS},(_,j)=>`<td class="color-cell">${available[j]?htmlEscape(available[j]):'&nbsp;'}</td>`).join('');
      return `<tr><td class="article-cell">${htmlEscape(p.code)}</td>${cells}</tr>`;
    }).join('');
    return `<section><h2>${htmlEscape(title)} <small>(${items.length} artículos)</small></h2><table><colgroup><col class="article-column">${'<col class="color-column">'.repeat(COLOR_COLUMNS)}</colgroup><thead><tr><th>ARTÍCULO</th><th colspan="${COLOR_COLUMNS}">COLORES DISPONIBLES</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  };
  const importedSections=[...Array.from(imported.entries()).sort(([a],[b])=>a.localeCompare(b,'es')).map(([name,items])=>table('MERCADERÍA IMPORTADA — '+name,items))];
  if(offers.length)importedSections.push(table('MERCADERÍA IMPORTADA — OFERTAS',offers));
  const sections=table('MERCADERÍA NACIONAL',national)+(importedSections.length?`<div class="imported-start">${importedSections.join('')}</div>`:'');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GOOD COMPANY - Informe para imprimir</title><style>
  @page{size:A4 portrait;margin:10mm}
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#111;background:white;margin:0;padding:10mm}
  .print-logo{display:block;width:320px;max-width:75%;height:auto;max-height:100px;object-fit:contain;margin:0 auto 12px}
  .sub{text-align:center;font-size:16px;margin:0 0 22px}
  .toolbar{display:flex;gap:10px;margin-bottom:15px}
  button{background:#153c5e;color:white;border:0;padding:12px 18px;border-radius:5px;cursor:pointer;font-size:16px}
  section{margin-bottom:28px}
  .imported-start{break-before:page;page-break-before:always}
  h2{font-size:19px;background:#ddd;padding:10px 12px;margin:0 0 6px;break-after:avoid;page-break-after:avoid}
  small{font-size:15px;font-weight:normal}
  table{border-collapse:collapse;width:100%;font-size:17px;table-layout:fixed}
  thead{display:table-header-group}
  tr{break-inside:avoid;page-break-inside:avoid}
  th,td{border:1.3px solid #444;padding:6px 3px;text-align:center;vertical-align:middle;overflow-wrap:anywhere;line-height:1.18}
  th{background:#e8e8e8;font-size:16px}
  .article-column{width:11%}.color-column{width:8.9%}
  th:first-child,td:first-child{font-weight:800}
  .article-cell{font-size:18px}
  .color-cell{font-size:13px;font-weight:700;word-break:normal;hyphens:auto}
  @media print{body{padding:0}.toolbar{display:none}.imported-start{break-before:page;page-break-before:always}h2,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}

  </style></head><body><div class="toolbar"><button onclick="window.print()">IMPRIMIR A4 VERTICAL</button><button onclick="window.close()">Cerrar</button></div><img class="print-logo" src="https://raw.githubusercontent.com/serper-1981/LOGOS/9c6587df170a9f27634b3ba05e01eabc4de636a2/NUEVO%20LOGO%20GC.png" alt="GOOD COMPANY"><p class="sub">ARTÍCULOS Y COLORES DISPONIBLES · ${products.length} artículos · ${new Date().toLocaleDateString('es-AR')}</p>${sections}</body></html>`;
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/auditoria-ventas-ejecutar') {
    const remote=req.socket.remoteAddress||'';
    if(process.env.GC_AUDIT_ONLY!=='1'||req.method!=='POST'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){
      res.writeHead(403);return res.end('No autorizado');
    }
    try{
      // Usar únicamente el catálogo publicado y entregado por el proceso de comparación.
      // Nunca volver a consultar ADMIN MASTER desde esta auditoría.
      const chunks=[];
      for await (const chunk of req) {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 200000) throw Error('Solicitud demasiado grande');
      }
      const payload=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      if (!Array.isArray(payload.codes) || !payload.codes.length || payload.codes.length > 10000) throw Error('Catálogo publicado inválido');
      const allowed=new Map(payload.codes.map(code=>[normalizeCode(code),true]).filter(([code])=>Boolean(code)));
      const result=await checkSalesListing(allowed);
      result.catalogUpdatedAt=payload.updatedAt||null;
      result.source='catalogo-publicado-cloudflare';
      result.adminStockSi=allowed.size;
      // El recuento de coincidencias verificadas se calcula en checkSalesListing.
      result.adminCodes=[...allowed.keys()].sort((a,b)=>a.localeCompare(b,'es',{numeric:true}));
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(JSON.stringify(result));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});
      return res.end(JSON.stringify({status:'error',note:e.message,checkedAt:new Date().toISOString(),missingFromSales:[]}));
    }
  }
  if (pathname === '/informe-colores') {
    if (req.method !== 'GET') {res.writeHead(405,{'Allow':'GET'});return res.end('Método no permitido');}
    if (!cache.products.length) {res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});return res.end('No hay artículos cargados para imprimir.');}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(printColorsHtml(cache.products));
  }
  if (pathname === '/api/stock') {
    // Responder al celular desde memoria, sin esperar a Playwright/MASTER.
    // Si hace falta refrescar, iniciar el trabajo en segundo plano.
    if (!pending && !autoTimer && Date.now() - lastRefreshAttempt > CACHE_MS) startBackgroundRefresh('automatica');
    res.writeHead(cache.products.length ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ updatedAt: cache.products.length && cache.time ? new Date(cache.time).toISOString() : null, products: cache.products, error: cache.error, diagnostic: cache.diagnostic, audit: lastDiagnostic, sync: syncState, refreshMinutes: CACHE_MS / 60000 }));
  }
  if (pathname === '/api/actualizar') {
    if (req.method !== 'POST') { res.writeHead(405, {'Allow':'POST'}); return res.end('Método no permitido'); }
    const now = Date.now();
    let accepted = false;
    if (!pending && now - lastManualRequest >= MANUAL_COOLDOWN_MS) {
      lastManualRequest = now;
      accepted = startBackgroundRefresh('manual');
    }
    res.writeHead(202, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify({accepted,running:!!pending,updatedAt:cache.time?new Date(cache.time).toISOString():null,sync:syncState,cooldownSeconds:Math.max(0,Math.ceil((MANUAL_COOLDOWN_MS-(now-lastManualRequest))/1000))}));
  }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'style.css', 'mobile.css', 'jenbach-logo-blanco.png'].includes(file)) { res.writeHead(404); return res.end('No encontrado'); }
  fs.readFile(path.join(__dirname, 'public', file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-cache' }); res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Stock Good Company: http://localhost:' + PORT + ' (red local habilitada)')); 
