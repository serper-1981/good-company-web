import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import zlib from 'node:zlib';
import { google } from 'googleapis';
import webpush from 'web-push';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// EXPRESS
// ============================================================

const app = express();


// ============================================================
// RELOJ OFICIAL GOOD COMPANY — ARGENTINA
// La fecha/hora de una SALE siempre corresponde al momento real
// de retiro en Buenos Aires, nunca a la fecha de la tarea.
// ============================================================
function obtenerFechaHoraBuenosAires(){
    const partes =
        new Intl.DateTimeFormat('es-AR',{
            timeZone:'America/Argentina/Buenos_Aires',
            year:'numeric',
            month:'2-digit',
            day:'2-digit',
            hour:'2-digit',
            minute:'2-digit',
            second:'2-digit',
            hour12:false
        }).formatToParts(new Date());

    const p={};
    for(const parte of partes){
        if(parte.type!=='literal'){
            p[parte.type]=parte.value;
        }
    }

    return {
        fecha:`${p.day}/${p.month}/${p.year}`,
        hora:`${p.hour}:${p.minute}:${p.second}`
    };
}

app.use(cors());

app.use(
    express.json({
        limit: '10mb'
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: '10mb'
    })
);

// ============================================================
// ARCHIVOS PUBLIC
// ============================================================


// ============================================================
// AUTENTICACIÓN GENERAL — GOOD COMPANY
// ============================================================

const AUTH_COOKIE = 'gc_auth';
const AUTH_DAYS = 30; // usado solo si alguna vez se habilita persistencia explícita

const PERMISOS_RUTA = {
    '/tareas.html': 'TAREAS',
    '/produccion.html': 'PRODUCCION',
    '/talleres.html': 'TALLERES',
    '/pagos.html': 'PAGOS',
    '/bd.html': 'BD',
    '/rollos.html': 'ROLLOS',
    '/stock-online.html': ['STOCK_ONLINE','PAGOS'],
    '/admin-usuarios.html': 'SUPERADMIN'
};

function obtenerCookie(req, nombre){
    const cookies = texto(req.headers.cookie);
    if(!cookies) return '';

    const encontrada = cookies
        .split(';')
        .map(x=>x.trim())
        .find(x=>x.startsWith(`${nombre}=`));

    return encontrada
        ? decodeURIComponent(encontrada.substring(nombre.length + 1))
        : '';
}

function authSecret(){
    return crypto
        .createHash('sha256')
        .update(
            `${process.env.BD_PASSWORD || 'GC'}|${GOOGLE_SHEET_ID || 'SHEET'}|GOOD_COMPANY_AUTH`
        )
        .digest('hex');
}

function firmarAuth(payload){
    return crypto
        .createHmac('sha256', authSecret())
        .update(payload)
        .digest('hex');
}

function crearTokenAuth(usuario, passwordHash, recordar){
    const expira = Date.now() + (
        recordar
            ? AUTH_DAYS * 24 * 60 * 60 * 1000
            : 12 * 60 * 60 * 1000
    );

    const hashFirma = crypto
        .createHash('sha256')
        .update(passwordHash)
        .digest('hex');

    const payload = `${usuario}|${expira}|${hashFirma}`;
    const firma = firmarAuth(payload);

    return Buffer
        .from(`${payload}|${firma}`, 'utf8')
        .toString('base64url');
}

function leerTokenAuth(req){
    const token = obtenerCookie(req, AUTH_COOKIE);
    if(!token) return null;

    try{
        const partes = Buffer
            .from(token, 'base64url')
            .toString('utf8')
            .split('|');

        if(partes.length !== 4) return null;

        const [usuario, expiraTexto, hashFirma, firma] = partes;
        const expira = Number(expiraTexto);

        if(!usuario || !Number.isFinite(expira) || expira < Date.now()){
            return null;
        }

        const payload = `${usuario}|${expira}|${hashFirma}`;
        const firmaEsperada = firmarAuth(payload);

        if(
            firma.length !== firmaEsperada.length ||
            !crypto.timingSafeEqual(
                Buffer.from(firma),
                Buffer.from(firmaEsperada)
            )
        ){
            return null;
        }

        return {usuario, expira, hashFirma};

    }catch{
        return null;
    }
}

function limpiarAuth(res){
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
}

function cookieAuth(res, token, recordar){
    // Si "Recordarme en esta PC" está marcado, la sesión persiste
    // aunque se cierre y se vuelva a abrir el navegador.
    // Si se desmarca, la sesión dura solo hasta cerrar el navegador.
    const extra = recordar
        ? `; Max-Age=${AUTH_DAYS * 24 * 60 * 60}`
        : '';

    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${extra}`
    );
}

function permisoParaRuta(ruta){
    if(PERMISOS_RUTA[ruta]) return PERMISOS_RUTA[ruta];

    // Informe de producción: usa TAREAS_ARTICULOS, pero pertenece
    // al módulo PRODUCCIÓN y no exige permiso TAREAS.
    if(ruta === '/api/produccion/informe') return 'PRODUCCION';

    // PAGOS puede consultar, imprimir y actualizar Stock Online.
    // Las operaciones administrativas se reservan a SUPERADMIN.
    if(ruta.startsWith('/api/stock-online/comparar-ventas')) return 'SUPERADMIN';
    if(ruta === '/api/stock-online/pedidos-config') return 'SUPERADMIN';
     if(ruta === '/api/stock-online/banner' ||
       ruta === '/api/stock-online/categorias' ||
       ruta === '/api/stock-online/orden-categorias') return 'SUPERADMIN';
    if(ruta.startsWith('/api/stock-online/')) return ['STOCK_ONLINE','PAGOS'];

    if(ruta.startsWith('/api/rollos')) return 'ROLLOS';
    if(ruta.startsWith('/api/bd')) return 'BD';

    if(ruta.startsWith('/api/pagos')){
        // La notificación de nuevos ingresos pendientes es un aviso
        // destinado únicamente a usuarios que tienen permiso BD.
        if(ruta === '/api/pagos/eventos'){
            return 'PAGOS';
        }

        // INDEX usa la creación de boleta de salida y PAGOS usa el resto.
        if(ruta === '/api/pagos/boleta-salida'){
            return ['INGRESOS_EGRESOS','PAGOS'];
        }

        return 'PAGOS';
    }

    if(ruta.startsWith('/api/tareas')) return 'TAREAS';

    if(ruta.startsWith('/api/admin/talleres')){
        return 'TALLERES';
    }

    if(
        ruta.startsWith('/api/admin/colores') ||
        ruta === '/api/colores-material' ||
        ruta.startsWith('/api/colores-material/')
    ){
        // TAREAS y TALLERES utilizan estas operaciones.
        return ['TAREAS','TALLERES'];
    }

    if(ruta === '/api/articulos' || ruta === '/api/talleres'){
        // Son datos compartidos por INDEX, PRODUCCIÓN y PAGOS.
        return ['INGRESOS_EGRESOS','PRODUCCION','PAGOS'];
    }

    if(ruta.startsWith('/api/talleres/')){
        if(ruta.endsWith('/salidas') || ruta.endsWith('/entradas')){
            return 'INGRESOS_EGRESOS';
        }
        if(ruta.endsWith('/pendientes')){
            return ['INGRESOS_EGRESOS','PRODUCCION'];
        }
    }

    // API autenticada sin permiso de módulo específico.
    return null;
}

function usuarioTienePermiso(usuario, permiso){
    if(!usuario) return false;
    if(permiso === 'SUPERADMIN') return normalizarTexto(usuario.ROL) === 'SUPERADMIN';
    if(normalizarTexto(usuario.ROL) === 'SUPERADMIN') return true;
    return esSi(usuario[permiso]);
}

async function obtenerUsuarios(){
    const filas = await obtenerHoja('USUARIOS','A2:M');

    return filas.map((fila,i)=>({
        fila:i+2,
        USUARIO:texto(fila?.[0]).toUpperCase(),
        NOMBRE:texto(fila?.[1]),
        PASSWORD_HASH:texto(fila?.[2]),
        ACTIVO:texto(fila?.[3]),
        ROL:texto(fila?.[4]).toUpperCase(),
        INGRESOS_EGRESOS:texto(fila?.[5]),
        TAREAS:texto(fila?.[6]),
        PRODUCCION:texto(fila?.[7]),
        TALLERES:texto(fila?.[8]),
        PAGOS:texto(fila?.[9]),
        BD:texto(fila?.[10]),
        ROLLOS:texto(fila?.[11]),
        STOCK_ONLINE:texto(fila?.[12])
    })).filter(u=>u.USUARIO);
}

async function obtenerUsuarioPorNombre(nombre){
    const buscado = texto(nombre).toUpperCase();
    if(!buscado) return null;

    const usuarios = await obtenerUsuarios();
    return usuarios.find(u=>u.USUARIO === buscado) || null;
}

function hashPassword(password){
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function comprobarPassword(password, almacenado){
    const partes = texto(almacenado).split('$');

    if(partes.length !== 3 || partes[0] !== 'scrypt') return false;

    try{
        const hash = crypto.scryptSync(
            String(password),
            partes[1],
            64
        ).toString('hex');

        const a = Buffer.from(hash,'hex');
        const b = Buffer.from(partes[2],'hex');

        return a.length === b.length &&
            crypto.timingSafeEqual(a,b);

    }catch{
        return false;
    }
}

// ============================================================
// SESIONES AUTENTICADAS EN MEMORIA
// ============================================================
// Usuario y permisos se comprueban contra USUARIOS al validar/
// iniciar la sesión. Mientras la sesión siga vigente se reutiliza
// esa información, evitando consultar Google Sheets en cada
// movimiento o petición autenticada.
// ============================================================
const sesionesGC = new Map();

function limpiarSesionesGC(){
    const ahora = Date.now();
    for(const [clave, sesion] of sesionesGC){
        if(!sesion || sesion.expira <= ahora) sesionesGC.delete(clave);
    }
}

function claveSesionGC(token){
    return token.usuario + '|' + token.expira + '|' + token.hashFirma;
}

async function usuarioDesdeRequest(req){
    const token = leerTokenAuth(req);
    if(!token) return null;

    const ahora = Date.now();
    const clave = claveSesionGC(token);
    const cacheada = sesionesGC.get(clave);

    if(cacheada && cacheada.expira > ahora){
        return cacheada.usuario;
    }

    const usuario = await obtenerUsuarioPorNombre(token.usuario);

    if(!usuario || !esSi(usuario.ACTIVO) || !usuario.PASSWORD_HASH){
        sesionesGC.delete(clave);
        return null;
    }

    const hashActual = crypto
        .createHash('sha256')
        .update(usuario.PASSWORD_HASH)
        .digest('hex');

    if(hashActual !== token.hashFirma){
        sesionesGC.delete(clave);
        return null;
    }

    sesionesGC.set(clave, {
        usuario,
        expira: token.expira
    });

    if(sesionesGC.size > 500) limpiarSesionesGC();

    return usuario;
}

async function authMejorada(req,res,next){
    try{
        const ruta = req.path;

        if(
            ruta === '/login.html' ||
            ruta.startsWith('/api/auth/')
        ){
            return next();
        }

        if(!ruta.endsWith('.html') && !ruta.startsWith('/api/')){
            return next();
        }

        const usuario = await usuarioDesdeRequest(req);

        if(!usuario){
            if(ruta.startsWith('/api/')){
                return res.status(401).json({
                    success:false,
                    error:'Sesión requerida.'
                });
            }

            const destino = encodeURIComponent(req.originalUrl || ruta);
            return res.redirect(`/login.html?next=${destino}`);
        }

        const permiso = permisoParaRuta(ruta);

        const permisosRequeridos = Array.isArray(permiso)
            ? permiso
            : (permiso ? [permiso] : []);

        const tienePermiso = permisosRequeridos.length === 0
            ? true
            : permisosRequeridos.some(p=>usuarioTienePermiso(usuario,p));

        if(permisosRequeridos.length && !tienePermiso){
            if(ruta.startsWith('/api/')){
                return res.status(403).json({
                    success:false,
                    error:`No tenés permiso para esta operación.`
                });
            }

            return res.status(403).send(`
                <!doctype html>
                <html lang="es">
                <head>
                    <meta charset="utf-8">
                    <title>Acceso denegado</title>
                    <style>
                        body{margin:0;background:#020617;color:#e2e8f0;
                        font-family:Arial;display:grid;place-items:center;height:100vh}
                        .box{background:#0f172a;border:1px solid #334155;
                        border-radius:16px;padding:30px;text-align:center}
                        button{margin-top:18px;background:#2563eb;color:white;
                        border:0;border-radius:10px;padding:12px 22px;
                        font-weight:800;cursor:pointer}
                    </style>
                </head>
                <body>
                    <div class="box">
                        <h2>🔒 ACCESO DENEGADO</h2>
                        <p>Tu usuario no tiene permiso para esta sección.</p>
                        <button onclick="location.href='/login.html'">VOLVER</button>
                    </div>
                </body>
                </html>
            `);
        }

        req.usuarioGC = usuario;
        next();

    }catch(error){
        console.error('❌ ERROR AUTENTICACIÓN:',error);

        if(req.path.startsWith('/api/')){
            return res.status(500).json({
                success:false,
                error:'No se pudo comprobar la sesión.'
            });
        }

        return res.status(500).send('Error comprobando la sesión.');
    }
}

// La raíz y /index.html son especiales: no tienen un permiso fijo.
// Primero se identifica al usuario y luego se decide su pantalla inicial.
async function redirigirSegunPermisos(req,res){
    const usuario = await usuarioDesdeRequest(req);

    if(!usuario){
        const destino = encodeURIComponent(req.originalUrl || '/');
        return res.redirect(`/login.html?next=${destino}`);
    }

    const opciones = [
        ['INGRESOS_EGRESOS','/index.html'],
        ['TAREAS','/tareas.html'],
        ['PRODUCCION','/produccion.html'],
        ['TALLERES','/talleres.html'],
        ['PAGOS','/pagos.html'],
        ['BD','/bd.html'],
        ['ROLLOS','/rollos.html'],
        ['STOCK_ONLINE','/stock-online.html']
    ];

    const destino = opciones.find(([permiso]) =>
        usuarioTienePermiso(usuario,permiso)
    );

    if(!destino){
        return res.status(403).send(`
            <!doctype html>
            <html lang="es">
            <head><meta charset="utf-8"><title>Acceso denegado</title></head>
            <body style="margin:0;background:#020617;color:#e2e8f0;font-family:Arial;display:grid;place-items:center;height:100vh">
                <div style="background:#0f172a;border:1px solid #334155;border-radius:16px;padding:30px;text-align:center">
                    <h2>🔒 ACCESO DENEGADO</h2>
                    <p>Tu usuario no tiene ningún módulo habilitado.</p>
                </div>
            </body>
            </html>
        `);
    }

    return res.redirect(destino[1]);
}

app.get('/', async (req,res)=>{
    try{
        return await redirigirSegunPermisos(req,res);
    }catch(error){
        console.error('❌ ERROR RUTA INICIAL:',error);
        return res.status(500).send('Error comprobando los permisos.');
    }
});

app.get('/index.html', async (req,res)=>{
    try{
        const usuario = await usuarioDesdeRequest(req);

        if(!usuario){
            const destino = encodeURIComponent(req.originalUrl || '/index.html');
            return res.redirect(`/login.html?next=${destino}`);
        }

        if(usuarioTienePermiso(usuario,'INGRESOS_EGRESOS')){
            return res.sendFile(path.join(__dirname,'public','index.html'));
        }

        return await redirigirSegunPermisos(req,res);
    }catch(error){
        console.error('❌ ERROR RUTA INDEX:',error);
        return res.status(500).send('Error comprobando los permisos.');
    }
});

// ============================================================
// SERVICE WORKER — DEBE PODER DESCARGARSE DIRECTAMENTE
// ============================================================
// No contiene secretos. Lo servimos antes de la autenticación
// para que Edge pueda instalarlo correctamente.
// ============================================================
app.get(
    '/sw.js',
    (req,res) => {
        res.setHeader('Content-Type','application/javascript; charset=utf-8');
        res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
        return res.sendFile(
            path.join(__dirname,'public','sw.js')
        );
    }
);


// ============================================================
// COLA DE AVISOS PAGOS — MEMORIA DEL SERVIDOR
// ============================================================
// Esta cola NO consulta Google Sheets. Solo guarda eventos que el
// servidor ya conoce porque acaba de completar un INGRESO o un
// REMIS AISLADO. Cada usuario con permiso PAGOS que mantenga el
// receptor activo obtiene su propia cola.
// ============================================================

const MAX_AVISOS_PAGOS_USUARIO = 100;
const TTL_VIGILANTE_AVISOS_PAGOS_MS = 2 * 60 * 1000;
const avisosPagosPorUsuario = new Map();
const vigilantesAvisosPagos = new Map();
let secuenciaAvisoPagos = 0;

function claveUsuarioPagos(usuario){
    return texto(usuario?.USUARIO || '').trim().toUpperCase();
}

function registrarVigilanteAvisosPagos(usuario){
    const clave = claveUsuarioPagos(usuario);
    if(!clave) return '';

    vigilantesAvisosPagos.set(clave, Date.now());

    if(!avisosPagosPorUsuario.has(clave)){
        avisosPagosPorUsuario.set(clave, []);
    }

    return clave;
}

function limpiarVigilantesAvisosPagos(){
    const ahora = Date.now();
    for(const [usuario, ultimaActividad] of vigilantesAvisosPagos){
        if(ahora - ultimaActividad > TTL_VIGILANTE_AVISOS_PAGOS_MS){
            vigilantesAvisosPagos.delete(usuario);
            // No borramos la cola: puede seguir pendiente hasta que el
            // usuario vuelva a abrir la aplicación dentro de la vigencia.
        }
    }
}

function encolarAvisoPagos(tipo, taller){
    const tipoNorm = texto(tipo).trim().toUpperCase() === 'REMIS_AISLADO'
        ? 'REMIS_AISLADO'
        : 'INGRESO';
    const tallerNorm = texto(taller).trim().toUpperCase();
    if(!tallerNorm) return 0;

    limpiarVigilantesAvisosPagos();

    let enviados = 0;
    const ahora = Date.now();

    for(const [usuario, ultimaActividad] of vigilantesAvisosPagos){
        if(ahora - ultimaActividad > TTL_VIGILANTE_AVISOS_PAGOS_MS){
            continue;
        }

        const cola = avisosPagosPorUsuario.get(usuario) || [];
        const evento = {
            id: `GC-${ahora}-${++secuenciaAvisoPagos}-${usuario}`,
            tipo: tipoNorm,
            taller: tallerNorm,
            creado: new Date(ahora).toISOString()
        };

        cola.push(evento);
        if(cola.length > MAX_AVISOS_PAGOS_USUARIO){
            cola.splice(0, cola.length - MAX_AVISOS_PAGOS_USUARIO);
        }

        avisosPagosPorUsuario.set(usuario, cola);
        enviados++;
    }

    console.log('🔔 AVISO PAGOS ENCOLADO:', {
        tipo: tipoNorm,
        taller: tallerNorm,
        usuarios: enviados
    });

    return enviados;
}

function obtenerAvisoPagosPendiente(usuario){
    limpiarVigilantesAvisosPagos();
    const clave = registrarVigilanteAvisosPagos(usuario);
    if(!clave) return null;
    const cola = avisosPagosPorUsuario.get(clave) || [];
    return cola.length ? cola[0] : null;
}

function confirmarAvisoPagos(usuario, id){
    const clave = registrarVigilanteAvisosPagos(usuario);
    if(!clave) return false;

    const cola = avisosPagosPorUsuario.get(clave) || [];
    const indice = cola.findIndex(item => item && item.id === String(id || ''));
    if(indice < 0) return false;

    cola.splice(indice, 1);
    avisosPagosPorUsuario.set(clave, cola);
    return true;
}


// CONFIGURACIÓN PÚBLICA DEL DESTINO DE PEDIDOS.
// Se lee de Google Sheets, no del navegador ni de memoria temporal.
const GC_PEDIDOS_HOJA = 'CONFIG_PEDIDOS';
async function leerNumeroPedidos(){
    if(!sheets) throw Error('Google Sheets no está conectado.');
    try{
        const r=await sheets.spreadsheets.values.get({spreadsheetId:GOOGLE_SHEET_ID,range:`${GC_PEDIDOS_HOJA}!A1:B2`});
        const filas=r.data.values||[];
        return filas[1]?.[0]==='WHATSAPP' ? String(filas[1]?.[1]||'') : '';
    }catch(e){
        if(e.code===400 || e.code===404 || /Unable to parse range/i.test(e.message||'')) return '';
        throw e;
    }
}
async function guardarNumeroPedidos(numero){
    if(!sheets) throw Error('Google Sheets no está conectado.');
    const info=await sheets.spreadsheets.get({spreadsheetId:GOOGLE_SHEET_ID,fields:'sheets.properties.title'});
    if(!(info.data.sheets||[]).some(s=>s.properties?.title===GC_PEDIDOS_HOJA)){
        try{await sheets.spreadsheets.batchUpdate({spreadsheetId:GOOGLE_SHEET_ID,requestBody:{requests:[{addSheet:{properties:{title:GC_PEDIDOS_HOJA}}}]}})}
        catch(e){if(!/already exists/i.test(e.message||''))throw e;}
    }
    await sheets.spreadsheets.values.update({spreadsheetId:GOOGLE_SHEET_ID,range:`${GC_PEDIDOS_HOJA}!A1:B2`,valueInputOption:'RAW',requestBody:{values:[['CLAVE','VALOR'],['WHATSAPP',numero]]}});
}
// Acceso público necesario para el catálogo de Cloudflare (solo devuelve el número receptor).
app.get('/api/public/stock-pedidos-config',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try{const numero=await leerNumeroPedidos();res.json({success:true,configured:!!numero,whatsapp:numero});}
    catch(e){console.error('Configuración pública de pedidos:',e.message);res.status(503).json({success:false,error:'Configuración temporalmente no disponible.'});}
});

app.use(authMejorada);

// STOCK ONLINE: controles exclusivos del sistema autenticado.
// Configurar GITHUB_STOCK_TOKEN (token GitHub con Actions: Read and write)
// y opcionalmente GITHUB_STOCK_REPO=serpereyra1981-GC/GOODCOMPANY-STOCK-ONLINE.
const STOCK_REPO = process.env.GITHUB_STOCK_REPO || 'serpereyra1981-GC/GOODCOMPANY-STOCK-ONLINE';
const STOCK_WORKFLOW = 'actualizar-stock.yml';
let ultimaSolicitudStock = 0;
async function githubStock(endpoint, options={}){
    const token=process.env.GITHUB_STOCK_TOKEN;
    if(!token)throw new Error('Falta configurar GITHUB_STOCK_TOKEN en el servidor GOOD COMPANY.');
    const response=await fetch(`https://api.github.com/repos/${STOCK_REPO}/${endpoint}`,{
        ...options,
        headers:{'Accept':'application/vnd.github+json','Authorization':`Bearer ${token}`,
            'X-GitHub-Api-Version':'2022-11-28',...(options.headers||{})}
    });
    if(!response.ok){
        console.error('GitHub Stock HTTP',response.status,await response.text().catch(()=>''));
        throw new Error(response.status===403?'Token sin permiso Actions o límite de GitHub.':`GitHub respondió ${response.status}.`);
    }
    return response.status===204?null:response.json();
}
// Progreso real por etapas de GitHub Actions, sin porcentajes por tiempo.
async function progresoStock(run){
    const data=await githubStock(`actions/runs/${run.id}/jobs?per_page=100`);
    const jobs=data.jobs||[];
    const steps=jobs.flatMap(job=>(job.steps||[]).map(step=>({...step,jobStatus:job.status})));
    const completed=steps.filter(step=>step.status==='completed').length;
    const current=steps.find(step=>step.status==='in_progress');
    const allJobsCompleted=jobs.length>0&&jobs.every(job=>job.status==='completed');
    return {completed,total:steps.length,percent:run.status==='completed'&&run.conclusion==='success'?100:
        (steps.length?Math.min(99,Math.floor(completed/steps.length*100)):null),
        stage:current?.name||(run.status==='completed'?'Finalizando…':allJobsCompleted?'Esperando siguiente tarea…':'Esperando inicio en GitHub…')};
}
async function progresoStockSeguro(run){
    try{return await progresoStock(run)}catch(e){return {percent:null,stage:'Trabajo en curso; avance temporalmente no disponible.'}}
}
app.post('/api/stock-online/actualizar',async(req,res)=>{
    // authMejorada ya validó sesión + permiso STOCK_ONLINE.
    if(Date.now()-ultimaSolicitudStock<60000)return res.status(429).json({success:false,error:'Ya se solicitó una actualización hace menos de un minuto.'});
    try{
        await githubStock(`actions/workflows/${STOCK_WORKFLOW}/dispatches`,{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ref:process.env.GITHUB_STOCK_REF||'main'})
        });
        ultimaSolicitudStock=Date.now();
        return res.json({success:true,requestedAt:new Date().toISOString(),message:'Actualización solicitada. GitHub comenzará la sincronización en breve.'});
    }catch(e){return res.status(502).json({success:false,error:e.message});}
});
app.get('/api/stock-online/estado',async(req,res)=>{
    try{
        const since=typeof req.query.since==='string'?Date.parse(req.query.since):NaN;
        const r=await githubStock(`actions/workflows/${STOCK_WORKFLOW}/runs?per_page=20`);
        const runs=r.workflow_runs||[];
        // Si hay una solicitud manual, seguir solamente ejecuciones manuales posteriores.
        // Se toleran 10 segundos de diferencia entre relojes de GitHub y del servidor.
        const run=Number.isFinite(since)
            ? runs.find(x=>x.event==='workflow_dispatch' && Date.parse(x.created_at)>=since-10000)
            : runs[0];
        return res.json({success:true,progress:run?await progresoStockSeguro(run):null,run:run?{id:run.id,status:run.status,conclusion:run.conclusion,created_at:run.created_at,updated_at:run.updated_at,html_url:run.html_url}:null});
    }catch(e){return res.status(502).json({success:false,error:e.message});}
});
// Auditoría manual exclusiva SUPERADMIN: workflow independiente del stock.
const VENTAS_WORKFLOW='comparar-web-ventas.yml';
let ultimaComparacionVentas=0;
app.post('/api/stock-online/comparar-ventas',async(req,res)=>{
    if(!usuarioTienePermiso(req.usuarioGC,'SUPERADMIN'))return res.status(403).json({success:false,error:'Solo SUPERADMIN puede comparar ventas.'});
    if(Date.now()-ultimaComparacionVentas<60000)return res.status(429).json({success:false,error:'Esperá un minuto antes de repetir la comparación.'});
    try{
        await githubStock(`actions/workflows/${VENTAS_WORKFLOW}/dispatches`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:process.env.GITHUB_STOCK_REF||'main'})});
        ultimaComparacionVentas=Date.now();
        res.json({success:true,requestedAt:new Date().toISOString(),message:'Comparación iniciada en GitHub.'});
    }catch(e){res.status(502).json({success:false,error:e.message})}
});
// ZIP pequeño con un solo JSON: leer archivo desde el artifact sin dependencias extra.
function jsonDesdeZip(buffer){
    // Leer el directorio central: admite ZIP con descriptor de datos.
    let end=-1;
    for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){
        if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
    }
    if(end<0)throw Error('ZIP de GitHub inválido');
    let pos=buffer.readUInt32LE(end+16);
    const count=buffer.readUInt16LE(end+10);
    for(let i=0;i<count;i++){
        if(buffer.readUInt32LE(pos)!==0x02014b50)throw Error('Directorio ZIP inválido');
        const method=buffer.readUInt16LE(pos+10),size=buffer.readUInt32LE(pos+20);
        const n=buffer.readUInt16LE(pos+28),e=buffer.readUInt16LE(pos+30),c=buffer.readUInt16LE(pos+32);
        const name=buffer.subarray(pos+46,pos+46+n).toString('utf8');
        if(name.endsWith('comparacion.json')){
            const local=buffer.readUInt32LE(pos+42);
            if(buffer.readUInt32LE(local)!==0x04034b50)throw Error('Entrada ZIP inválida');
            const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);
            if(start+size>buffer.length)throw Error('Archivo ZIP incompleto');
            const data=buffer.subarray(start,start+size);
            const decoded=method===8?zlib.inflateRawSync(data):method===0?data:null;
            if(!decoded)throw Error('Compresión ZIP no admitida');
            return JSON.parse(decoded.toString('utf8'));
        }
        pos+=46+n+e+c;
    }
    throw Error('No se encontró el informe en el archivo de GitHub.');
}
app.get('/api/stock-online/comparar-ventas/estado',async(req,res)=>{
    if(!usuarioTienePermiso(req.usuarioGC,'SUPERADMIN'))return res.status(403).json({success:false,error:'Solo SUPERADMIN.'});
    try{
        const since=Date.parse(String(req.query.since||''));
        if(!Number.isFinite(since))return res.status(400).json({success:false,error:'Falta la fecha de solicitud.'});
        const runs=await githubStock(`actions/workflows/${VENTAS_WORKFLOW}/runs?per_page=20`);
        const run=(runs.workflow_runs||[]).find(x=>x.event==='workflow_dispatch'&&Date.parse(x.created_at)>=since-10000);
        if(!run)return res.json({success:true,status:'waiting'});
        if(run.status!=='completed')return res.json({success:true,status:'running',runId:run.id,progress:await progresoStockSeguro(run)});
        if(run.conclusion!=='success')return res.json({success:true,status:'error',note:'GitHub finalizó con '+run.conclusion,runUrl:run.html_url});
        const artifacts=await githubStock(`actions/runs/${run.id}/artifacts`);
        const artifact=(artifacts.artifacts||[]).find(a=>a.name==='comparacion-web-ventas'&&!a.expired);
        if(!artifact)return res.json({success:true,status:'processing',note:'Esperando que GitHub publique el informe.'});
        const token=process.env.GITHUB_STOCK_TOKEN;
        const download=await fetch(artifact.archive_download_url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
        if(!download.ok)throw Error('No se pudo descargar el informe: HTTP '+download.status);
        const report=jsonDesdeZip(Buffer.from(await download.arrayBuffer()));
        res.json({success:true,status:'completed',report});
    }catch(e){res.status(502).json({success:false,error:e.message})}
});
app.get('/api/stock-online/catalogo',async(req,res)=>{
    try{
        const response=await fetch('https://goodcompany-stock-online.pages.dev/api/stock',{signal:AbortSignal.timeout(12000)});
        if(!response.ok)throw new Error('El catálogo no respondió correctamente.');
        const data=await response.json();
        return res.json({success:true,updatedAt:data.updatedAt,articulos:Array.isArray(data.products)?data.products.length:0});
    }catch(e){return res.status(502).json({success:false,error:e.message});}
});


// Banner: el token de Northflank solo necesita permiso Actions (no Contents).
app.get('/api/stock-online/banner-admin',async(req,res)=>{
    const u=req.usuarioGC||await usuarioDesdeRequest(req);
    res.json({success:true,superadmin:!!u&&normalizarTexto(u.ROL)==='SUPERADMIN'});
});
app.post('/api/stock-online/banner',async(req,res)=>{
    const u=req.usuarioGC||await usuarioDesdeRequest(req);
    if(!u||normalizarTexto(u.ROL)!=='SUPERADMIN')return res.status(403).json({success:false,error:'Solo SUPERADMIN puede cambiar el banner.'});
    const {active,image}=req.body||{};
    if(typeof active!=='boolean'||typeof image!=='string'||image.length>51000||!(/^[A-Za-z0-9+/=]*$/.test(image)))return res.status(400).json({success:false,error:'Imagen inválida o demasiado grande.'});
    try{
        await githubStock('actions/workflows/administrar-banner.yml/dispatches',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ref:process.env.GITHUB_STOCK_REF||'main',inputs:{active:String(active),...Object.fromEntries(Array.from({length:8},(_,i)=>['part'+(i+1),image.slice(i*8000,(i+1)*8000)]))}})
        });
        res.json({success:true,message:'Banner enviado. Se publicará al finalizar GitHub Actions (puede demorar unos minutos).'});
    }catch(e){res.status(502).json({success:false,error:e.message});}
});

app.get('/api/stock-online/categorias',async(req,res)=>{
    const u=req.usuarioGC||await usuarioDesdeRequest(req);
    if(!u||normalizarTexto(u.ROL)!=='SUPERADMIN')return res.status(403).json({success:false,error:'Solo SUPERADMIN puede ordenar categorías.'});
    try{
        const base='https://goodcompany-stock-online.pages.dev';
        // El catálogo ya responde desde /api/stock-online/catalogo.
        // La configuración de orden es opcional: no bloquear la lista si falta o tarda.
        const stockResponse=await fetch(base+'/api/stock',{signal:AbortSignal.timeout(15000)});
        if(!stockResponse.ok)throw Error('No se pudo leer el catálogo (HTTP '+stockResponse.status+').');
        const stock=await stockResponse.json();
        let existing={};
        try {
            const orderResponse=await fetch(base+'/category-order.json',{signal:AbortSignal.timeout(3500),headers:{'Cache-Control':'no-cache'}});
            if(orderResponse.ok)existing=await orderResponse.json();
        } catch(err) { console.warn('Orden de categorías opcional no disponible:',err.message); }
        const normalize=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
        const products=Array.isArray(stock.products)?stock.products:[];
        const imported=x=>/IMPORTAD/i.test((x.line||'')+' '+(x.motivo||''))||/\bJENBACH\b/i.test([x.category,x.description,x.code].join(' '));
        const newSeason=x=>/NUEVA\s+TEMPORADA/i.test([x.category,x.description,x.code,x.line].join(' '));
        const categories=[];
        for(const x of products){
            const group=newSeason(x)?'NUEVA TEMPORADA':(imported(x)?(normalize(x.category)||'SIN CATEGORIA'):'LÍNEA NACIONAL');
            if(!categories.includes(group))categories.push(group);
        }
        const defaults=['NUEVA TEMPORADA','LÍNEA NACIONAL'];
        categories.sort((a,b)=>{const ia=defaults.indexOf(a),ib=defaults.indexOf(b);if(ia!==-1||ib!==-1)return (ia<0?999:ia)-(ib<0?999:ib);return a.localeCompare(b,'es')});
        const order=Array.isArray(existing.order)?existing.order.filter(x=>typeof x==='string'):[];
        return res.json({success:true,categories,order});
    }catch(e){return res.status(502).json({success:false,error:e.message});}
});
app.post('/api/stock-online/orden-categorias',async(req,res)=>{
    const u=req.usuarioGC||await usuarioDesdeRequest(req);
    if(!u||normalizarTexto(u.ROL)!=='SUPERADMIN')return res.status(403).json({success:false,error:'Solo SUPERADMIN puede ordenar categorías.'});
    const order=req.body?.order;
    if(!Array.isArray(order)||order.length>120||order.some(x=>typeof x!=='string'||x.length>100))
        return res.status(400).json({success:false,error:'Lista de categorías inválida.'});
    const clean=[...new Set(order.map(x=>x.trim()).filter(Boolean))];
    try{
        await githubStock('actions/workflows/administrar-categorias.yml/dispatches',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ref:process.env.GITHUB_STOCK_REF||'main',inputs:{order:JSON.stringify(clean)}})
        });
        res.json({success:true,message:'Orden enviado para publicación. Puede tardar unos minutos.'});
    }catch(e){res.status(502).json({success:false,error:e.message});}
});
// Configuración de pedidos: solo SUPERADMIN puede consultar y modificar.
app.get('/api/stock-online/pedidos-config',async(req,res)=>{
    if(!usuarioTienePermiso(req.usuarioGC,'SUPERADMIN'))return res.status(403).json({success:false,error:'Solo SUPERADMIN puede configurar pedidos.'});
    try{const whatsapp=await leerNumeroPedidos();res.json({success:true,whatsapp});}
    catch(e){res.status(503).json({success:false,error:'No se pudo leer la configuración: '+e.message});}
});
app.post('/api/stock-online/pedidos-config',async(req,res)=>{
    if(!usuarioTienePermiso(req.usuarioGC,'SUPERADMIN'))return res.status(403).json({success:false,error:'Solo SUPERADMIN puede configurar pedidos.'});
    let local=String(req.body?.whatsapp||'').replace(/\D/g,'');
    if(local.startsWith('0054'))local=local.slice(4);
    else if(local.startsWith('54'))local=local.slice(2);
    const whatsapp='54'+local;
    if(!/^9\d{10}$/.test(local))return res.status(400).json({success:false,error:'Ingresá 9 + código de área + número de celular (11 dígitos después del +54). Ejemplo: 9 11 1234 5678.'});
    try{await guardarNumeroPedidos(whatsapp);res.json({success:true,whatsapp,message:'Número de pedidos guardado correctamente.'});}
    catch(e){console.error('Guardando WhatsApp de pedidos:',e);res.status(503).json({success:false,error:'No se pudo guardar la configuración: '+e.message});}
});

// ============================================================
// API NOTIFICACIONES WINDOWS
// ============================================================

app.get(
    '/api/notificaciones/vapid-public-key',
    async (req,res) => {
        try{
            const usuario = await usuarioDesdeRequest(req);
            if(!usuario){
                return res.status(401).json({
                    success:false,
                    error:'Sesión no válida.'
                });
            }

            if(!vapidKeys?.publicKey){
                return res.status(500).json({
                    success:false,
                    error:'Web Push no está inicializado.'
                });
            }

            return res.json({
                success:true,
                publicKey:vapidKeys.publicKey,
                puedeRecibirPagos:usuarioTienePermiso(usuario,'PAGOS')
            });
        }catch(error){
            console.error('❌ ERROR VAPID:',error);
            return res.status(500).json({
                success:false,
                error:error.message
            });
        }
    }
);

app.get(
    '/api/notificaciones/permisos',
    async (req,res) => {
        try{
            const usuario = await usuarioDesdeRequest(req);
            if(!usuario){
                return res.status(401).json({
                    success:false,
                    error:'Sesión no válida.'
                });
            }

            return res.json({
                success:true,
                usuario:usuario.USUARIO,
                puedeRecibirPagos:usuarioTienePermiso(usuario,'PAGOS')
            });
        }catch(error){
            console.error('❌ ERROR CONSULTANDO PERMISOS PUSH:',error);
            return res.status(500).json({
                success:false,
                error:error.message
            });
        }
    }
);

app.post(
    '/api/notificaciones/suscribir',
    async (req,res) => {
        try{
            const usuario = await usuarioDesdeRequest(req);

            if(!usuario){
                return res.status(401).json({
                    success:false,
                    error:'Sesión no válida.'
                });
            }

            // SOLO usuarios con permiso PAGOS pueden registrar una PC
            // para recibir avisos de PAGOS.
            if(!usuarioTienePermiso(usuario,'PAGOS')){
                return res.status(403).json({
                    success:false,
                    error:'El usuario no tiene permiso PAGOS.',
                    puedeRecibirPagos:false
                });
            }

            const subscription = req.body?.subscription;

            if(!subscription || !subscription.endpoint){
                return res.status(400).json({
                    success:false,
                    error:'Suscripción Push inválida.'
                });
            }

            const registro = {
                usuario:usuario.USUARIO,
                subscription
            };

            const existe = pushSubscriptions.some(
                item =>
                    (item?.subscription?.endpoint || item?.endpoint) ===
                    subscription.endpoint
            );

            if(!existe){
                pushSubscriptions.push(registro);
            }else{
                pushSubscriptions = pushSubscriptions.map(item => {
                    const endpoint = item?.subscription?.endpoint || item?.endpoint;
                    return endpoint === subscription.endpoint ? registro : item;
                });
            }

            guardarPushSubscriptions();

            console.log(
                `🟢 WEB PUSH: ${usuario.USUARIO} registrado (${pushSubscriptions.length} dispositivo(s)).`
            );

            return res.json({
                success:true,
                suscripto:true,
                usuario:usuario.USUARIO,
                puedeRecibirPagos:true
            });

        }catch(error){
            console.error('❌ ERROR GUARDANDO SUSCRIPCIÓN PUSH:',error);
            return res.status(500).json({
                success:false,
                error:error.message
            });
        }
    }
);

app.post(
    '/api/notificaciones/desuscribir',
    async (req,res) => {
        try{
            const usuario = await usuarioDesdeRequest(req);
            const endpoint = texto(req.body?.endpoint);

            if(!usuario){
                return res.status(401).json({
                    success:false,
                    error:'Sesión no válida.'
                });
            }

            if(endpoint){
                pushSubscriptions = pushSubscriptions.filter(item => {
                    const itemEndpoint = item?.subscription?.endpoint || item?.endpoint;
                    const itemUsuario = texto(item?.usuario).toUpperCase();
                    return !(itemEndpoint === endpoint && itemUsuario === usuario.USUARIO);
                });
                guardarPushSubscriptions();
            }

            return res.json({success:true});

        }catch(error){
            console.error('❌ ERROR ELIMINANDO SUSCRIPCIÓN PUSH:',error);
            return res.status(500).json({
                success:false,
                error:error.message
            });
        }
    }
);



app.use((req,res,next)=>{
    if(req.path.endsWith('.html') || req.path.startsWith('/api/')){
        res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma','no-cache');
        res.setHeader('Expires','0');
    }
    next();
});

// La ruta raíz y /index.html se resuelven de forma dinámica según
// el usuario autenticado y sus permisos. No dejamos que express.static
// entregue index.html automáticamente antes de comprobarlos.
app.use(
    express.static(
        path.join(__dirname,'public'),
        { index: false }
    )
);

// ============================================================
// CONFIGURACIÓN
// ============================================================

const PORT =
    process.env.PORT ||
    3000;

// ============================================================
// NOTIFICACIONES WINDOWS — WEB PUSH
// ============================================================

const PUSH_SUBSCRIPTIONS_FILE =
    path.join(
        __dirname,
        'push-subscriptions.json'
    );

const VAPID_KEYS_FILE =
    path.join(
        __dirname,
        'vapid-keys.json'
    );

let vapidKeys = null;
let pushSubscriptions = [];

function cargarJsonSeguro(archivo, valorDefecto){
    try{
        if(!fs.existsSync(archivo)){
            return valorDefecto;
        }

        const contenido =
            fs.readFileSync(
                archivo,
                'utf8'
            );

        return JSON.parse(contenido);
    }catch(error){
        console.error(
            `⚠️ ERROR LEYENDO ${path.basename(archivo)}:`,
            error.message
        );
        return valorDefecto;
    }
}

function guardarJsonSeguro(archivo, valor){
    try{
        fs.writeFileSync(
            archivo,
            JSON.stringify(valor,null,2),
            'utf8'
        );
        return true;
    }catch(error){
        console.error(
            `⚠️ ERROR GUARDANDO ${path.basename(archivo)}:`,
            error.message
        );
        return false;
    }
}

function inicializarWebPush(){
    try{
        vapidKeys =
            cargarJsonSeguro(
                VAPID_KEYS_FILE,
                null
            );

        if(
            !vapidKeys ||
            !vapidKeys.publicKey ||
            !vapidKeys.privateKey
        ){
            vapidKeys =
                webpush.generateVAPIDKeys();

            guardarJsonSeguro(
                VAPID_KEYS_FILE,
                vapidKeys
            );

            console.log(
                '🔐 VAPID: nuevas claves generadas y guardadas.'
            );
        }

        pushSubscriptions =
            cargarJsonSeguro(
                PUSH_SUBSCRIPTIONS_FILE,
                []
            );

        if(!Array.isArray(pushSubscriptions)){
            pushSubscriptions = [];
        }

        webpush.setVapidDetails(
            'mailto:goodcompany@localhost',
            vapidKeys.publicKey,
            vapidKeys.privateKey
        );

        console.log(
            `🔔 WEB PUSH: ${pushSubscriptions.length} suscripción(es) cargada(s).`
        );

    }catch(error){
        console.error(
            '❌ ERROR INICIALIZANDO WEB PUSH:',
            error.message
        );
        vapidKeys = null;
        pushSubscriptions = [];
    }
}

function guardarPushSubscriptions(){
    return guardarJsonSeguro(
        PUSH_SUBSCRIPTIONS_FILE,
        pushSubscriptions
    );
}

async function enviarNotificacionWindows({
    titulo,
    mensaje,
    tag
}){
    if(!vapidKeys || !Array.isArray(pushSubscriptions) || !pushSubscriptions.length){
        console.log('ℹ️ WEB PUSH: no hay dispositivos suscriptos.');
        return;
    }

    let usuarios = [];
    try{
        usuarios = await obtenerUsuarios();
    }catch(error){
        console.error('❌ WEB PUSH: no se pudieron comprobar permisos PAGOS:',error.message);
        return;
    }

    const usuariosPagos = new Set(
        usuarios
            .filter(usuario => usuarioTienePermiso(usuario,'PAGOS'))
            .map(usuario => usuario.USUARIO)
    );

    const payload = JSON.stringify({
        title:String(titulo || 'GOOD COMPANY'),
        body:String(mensaje || ''),
        tag:String(tag || 'good-company'),
        url:'/pagos.html'
    });

    const vigentes = [];

    for(const item of pushSubscriptions){
        const subscription = item?.subscription || item;
        const usuario = texto(item?.usuario).toUpperCase();

        // Las suscripciones antiguas que no tienen usuario asociado NO
        // reciben avisos: así no existe ninguna posibilidad de enviar
        // PAGOS a una PC sin permiso.
        if(!usuario || !usuariosPagos.has(usuario)){
            continue;
        }

        try{
            await webpush.sendNotification(subscription,payload);
            vigentes.push(item);
        }catch(error){
            if(error.statusCode === 404 || error.statusCode === 410){
                console.warn(`⚠️ WEB PUSH: eliminando suscripción vencida de ${usuario}.`);
                continue;
            }

            console.error('❌ ERROR ENVIANDO WEB PUSH:',error.statusCode || '',error.message);
            vigentes.push(item);
        }
    }

    if(vigentes.length !== pushSubscriptions.length){
        pushSubscriptions = vigentes;
        guardarPushSubscriptions();
    }
}

async function notificarNuevoIngresoTaller(taller){
    const nombre =
        texto(taller).trim().toUpperCase();

    if(!nombre) return;

    await enviarNotificacionWindows({
        titulo:'GOOD COMPANY',
        mensaje:`Nuevo ingreso del taller ${nombre}`,
        tag:`ingreso-${normalizarTexto(nombre)}`
    });
}

async function notificarNuevoRemisTaller(taller){
    const nombre =
        texto(taller).trim().toUpperCase();

    if(!nombre) return;

    await enviarNotificacionWindows({
        titulo:'GOOD COMPANY',
        mensaje:`Nuevo REMIS del taller ${nombre}`,
        tag:`remis-${normalizarTexto(nombre)}`
    });
}

inicializarWebPush();


// ============================================================
// AVISO PAGOS EN TIEMPO REAL
// ============================================================
// No hace consultas cada X segundos.
// El servidor avisa solamente cuando se produce un movimiento
// que puede cambiar el estado de PAGOS.
// ============================================================

const clientesAvisoPagos = new Set();

let talleresPendientesAvisoAnterior = null;

function obtenerTalleresPendientesUnicos(movimientos){
    const pendientes = obtenerMovimientosPendientesPago(movimientos);
    const unicos = new Map();

    for(const movimiento of pendientes){
        const taller = texto(movimiento.taller).trim();
        if(!taller) continue;

        const clave = normalizarTexto(taller);
        if(!unicos.has(clave)) unicos.set(clave,taller);
    }

    return {
        pendientes,
        talleres:[...unicos.values()]
    };
}

async function emitirEstadoAvisoPagos() {
    try {
        const movimientos = await obtenerMovimientosPagos();
        const estado = obtenerTalleresPendientesUnicos(movimientos);

        const actual = new Set(
            estado.talleres.map(t=>normalizarTexto(t))
        );

        const nuevosTalleres =
            talleresPendientesAvisoAnterior === null
                ? []
                : estado.talleres.filter(
                    t => !talleresPendientesAvisoAnterior.has(
                        normalizarTexto(t)
                    )
                );

        talleresPendientesAvisoAnterior = actual;

        const mensaje = `event: pagos\ndata: ${JSON.stringify({
            pendientes: estado.talleres.length,
            talleresPendientes: estado.talleres,
            nuevosTalleres,
            hayPendientes: estado.talleres.length > 0
        })}\n\n`;

        for(const res of clientesAvisoPagos){
            try{
                res.write(mensaje);
            }catch(_){
                clientesAvisoPagos.delete(res);
            }
        }
    }catch(error){
        console.error('⚠️ ERROR AVISO PAGOS:',error.message);
    }
}

// ============================================================
// AVISO EXPLÍCITO — FINALIZAR INGRESO
// Una visita del taller genera UNA sola notificación.
// Se usa cuando el operador termina de asentar todos los ingresos.
// ============================================================
async function emitirAvisoPagosTaller(taller) {
    const tallerTexto = texto(taller).trim();
    if (!tallerTexto) return;

    // Aviso directo: no vuelve a leer Google Sheets.
    // El servidor ya conoce qué taller acaba de finalizar.
    const mensaje = `event: pagos\ndata: ${JSON.stringify({
        pendientes: 0,
        talleresPendientes: [],
        nuevosTalleres: [tallerTexto],
        hayPendientes: true,
        motivo: 'FINALIZAR_INGRESO'
    })}\n\n`;

    for (const res of clientesAvisoPagos) {
        try {
            res.write(mensaje);
        } catch (_) {
            clientesAvisoPagos.delete(res);
        }
    }
}


// ============================================================
// GOOGLE SHEETS
// ============================================================

const GOOGLE_SHEET_ID =
    process.env.GOOGLE_SHEET_ID;

const GOOGLE_CREDENTIALS_FILE =
    path.join(
        __dirname,
        'google-credentials.json'
    );

let sheets = null;

// ============================================================
// LOCKS PARA REMIS ABIERTOS
// Evita que dos salidas del mismo taller/día creen boletas
// distintas cuando llegan casi al mismo tiempo.
// ============================================================

const locksRemis =
    new Map();

// ============================================================
// UTILIDADES
// ============================================================

function texto(valor) {

    if (
        valor === null ||
        valor === undefined
    ) {

        return '';

    }

    return String(valor).trim();

}

function segundosHora(
    valor
) {

    const partes =
        String(
            valor || ''
        )
        .trim()
        .split(':');

    if (
        partes.length < 2
    ) {

        return null;

    }

    const horas =
        Number(
            partes[0]
        );

    const minutos =
        Number(
            partes[1]
        );

    const segundos =
        partes.length >= 3
            ? Number(partes[2])
            : 0;

    if (
        !Number.isFinite(horas) ||
        !Number.isFinite(minutos) ||
        !Number.isFinite(segundos)
    ) {

        return null;

    }

    return (
        horas * 3600 +
        minutos * 60 +
        segundos
    );

}

function normalizarTexto(valor) {

    return texto(valor).toUpperCase();

}

function esSi(valor) {

    // Google Sheets usa "SI"/"NO", mientras que el panel de
    // administración envía true/false desde los checkbox.
    if (valor === true) return true;
    if (valor === false) return false;

    return normalizarTexto(valor) === 'SI';

}

function numero(valor) {

    if (
        valor === null ||
        valor === undefined ||
        valor === ''
    ) {

        return 0;

    }

    const n =
        Number(
            String(valor)
                .replace(',', '.')
        );

    return Number.isFinite(n)
        ? n
        : 0;

}

// ============================================================
// FECHAS
// ============================================================

function fechaParaSheet(fecha) {

    if (!fecha) {

        return '';

    }

    if (
        typeof fecha === 'string' &&
        /^\d{2}\/\d{2}\/\d{4}$/.test(
            fecha
        )
    ) {

        return fecha;

    }

    const d =
        new Date(fecha);

    if (
        Number.isNaN(
            d.getTime()
        )
    ) {

        return '';

    }

    const dia =
        String(
            d.getDate()
        ).padStart(
            2,
            '0'
        );

    const mes =
        String(
            d.getMonth() + 1
        ).padStart(
            2,
            '0'
        );

    const anio =
        d.getFullYear();

    return `${dia}/${mes}/${anio}`;

}

// ============================================================
// FECHA + HORA PARA ORDENAR PAGOS
// ============================================================

function fechaHoraParaOrden(
    fecha,
    hora
) {

    const fechaTexto =
        texto(fecha);

    const horaTexto =
        texto(hora);

    const partesFecha =
        fechaTexto.split('/');

    let dia = 0;
    let mes = 0;
    let anio = 0;

    if (
        partesFecha.length === 3
    ) {

        dia =
            Number(
                partesFecha[0]
            ) || 0;

        mes =
            Number(
                partesFecha[1]
            ) || 0;

        anio =
            Number(
                partesFecha[2]
            ) || 0;

    }

    const partesHora =
        horaTexto.split(':');

    const horas =
        Number(
            partesHora[0]
        ) || 0;

    const minutos =
        Number(
            partesHora[1]
        ) || 0;

    const segundos =
        Number(
            partesHora[2]
        ) || 0;

    return new Date(
        anio,
        mes - 1,
        dia,
        horas,
        minutos,
        segundos
    ).getTime();

}

// ============================================================
// GOOGLE SHEETS AUTH
// ============================================================

async function conectarGoogleSheets() {

    try {

        console.log('');
        console.log(
            '🔵 Conectando con Google Sheets...'
        );

        if (
            !fs.existsSync(
                GOOGLE_CREDENTIALS_FILE
            )
        ) {

            throw new Error(
                'No existe google-credentials.json'
            );

        }

        const credenciales =
            JSON.parse(
                fs.readFileSync(
                    GOOGLE_CREDENTIALS_FILE,
                    'utf8'
                )
            );

        const auth =
            new google.auth.GoogleAuth({

                credentials:
                    credenciales,

                scopes: [

                    'https://www.googleapis.com/auth/spreadsheets'

                ]

            });

        sheets =
            google.sheets({

                version:
                    'v4',

                auth

            });

        await sheets.spreadsheets.values.get({

            spreadsheetId:
                GOOGLE_SHEET_ID,

            range:
                'BD!A1:N1'

        });

        console.log('');
        console.log(
            '🟢 GOOGLE SHEETS CONECTADO.'
        );

        const encabezados =
            await obtenerHoja(
                'BD',
                'A1:N1'
            );

        console.log(
            '📄 Hoja BD detectada.'
        );

        console.log(
            '📋 Encabezados:',
            encabezados[0] || []
        );

        return true;

    } catch (error) {

        console.log('');
        console.log(
            '🔴 ERROR CONECTANDO GOOGLE SHEETS'
        );

        console.log(
            error.message
        );

        sheets = null;

        return false;

    }

}

// ============================================================
// OBTENER RANGO GOOGLE SHEETS
// ============================================================

async function obtenerHoja(
    nombreHoja,
    rango
) {

    if (!sheets) {

        throw new Error(
            'Google Sheets no está conectado.'
        );

    }

    const respuesta =
        await sheets.spreadsheets.values.get({

            spreadsheetId:
                GOOGLE_SHEET_ID,

            range:
                `${nombreHoja}!${rango}`

        });

    return (
        respuesta.data.values ||
        []
    );

}

// ============================================================
// AGREGAR FILA
// ============================================================

async function agregarFila(
    nombreHoja,
    valores
) {

    if (!sheets) {

        throw new Error(
            'Google Sheets no está conectado.'
        );

    }

    await sheets.spreadsheets.values.append({

        spreadsheetId:
            GOOGLE_SHEET_ID,

        range:
            `${nombreHoja}!A:A`,

        valueInputOption:
            'USER_ENTERED',

        insertDataOption:
            'INSERT_ROWS',

        requestBody: {

            values: [
                valores
            ]

        }

    });

    if (nombreHoja === 'BD') {
        invalidarCacheMovimientosPagos();
    }

}

// ============================================================
// ACTUALIZAR FILA
// ============================================================

async function actualizarFila(
    nombreHoja,
    fila,
    valores
) {

    if (!sheets) {

        throw new Error(
            'Google Sheets no está conectado.'
        );

    }

    const letras=[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    const ultima=letras[Math.max(0,valores.length-1)];

    await sheets.spreadsheets.values.update({

        spreadsheetId:
            GOOGLE_SHEET_ID,

        range:
            `${nombreHoja}!A${fila}:${ultima}${fila}`,

        valueInputOption:
            'USER_ENTERED',

        requestBody: {

            values: [
                valores
            ]

        }

    });

    if (nombreHoja === 'BD') {
        invalidarCacheMovimientosPagos();
    }

}


// ============================================================
// ACTUALIZAR RANGO DE FILA — CANTIDAD DE COLUMNAS VARIABLE
// ============================================================

async function actualizarFilaRango(
    nombreHoja,
    fila,
    valores
) {
    if (!sheets) throw new Error('Google Sheets no está conectado.');

    const letras=[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    const ultima=letras[Math.max(0,valores.length-1)];

    await sheets.spreadsheets.values.update({
        spreadsheetId:GOOGLE_SHEET_ID,
        range:`${nombreHoja}!A${fila}:${ultima}${fila}`,
        valueInputOption:'USER_ENTERED',
        requestBody:{values:[valores]}
    });

    if (nombreHoja === 'BD') {
        invalidarCacheMovimientosPagos();
    }
}

// ============================================================
// OBTENER METADATOS DE HOJA
// ============================================================

async function obtenerSheetId(
    nombreHoja
) {

    const meta =
        await sheets.spreadsheets.get({

            spreadsheetId:
                GOOGLE_SHEET_ID,

            fields:
                'sheets(properties(sheetId,title))'

        });

    const hoja =
        meta.data.sheets.find(
            s =>
                s.properties.title ===
                nombreHoja
        );

    if (!hoja) {

        throw new Error(
            `No existe la hoja ${nombreHoja}`
        );

    }

    return hoja.properties.sheetId;

}

// ============================================================
// BORRAR FILA
// ============================================================

async function borrarFila(
    nombreHoja,
    fila
) {

    if (!sheets) {

        throw new Error(
            'Google Sheets no está conectado.'
        );

    }

    const sheetId =
        await obtenerSheetId(
            nombreHoja
        );

    await sheets.spreadsheets.batchUpdate({

        spreadsheetId:
            GOOGLE_SHEET_ID,

        requestBody: {

            requests: [

                {

                    deleteDimension: {

                        range: {

                            sheetId:
                                sheetId,

                            dimension:
                                'ROWS',

                            startIndex:
                                fila - 1,

                            endIndex:
                                fila

                        }

                    }

                }

            ]

        }

    });

}

// ============================================================
// LEER MOVIMIENTOS BD
// ============================================================

async function obtenerMovimientos() {

    const filas =
        await obtenerHoja(
            'BD',
            'A2:R'
        );

    const movimientos =
        [];

    for (
        let i = 0;
        i < filas.length;
        i++
    ) {

        const fila =
            filas[i] || [];

        const id =
            texto(
                fila[0]
            );

        if (!id) {

            continue;

        }

        movimientos.push({

            id:
                id,

            fila:
                i + 2,

            fecha:
                texto(
                    fila[1]
                ),

            taller:
                texto(
                    fila[2]
                ),

            articulo:
                texto(
                    fila[3]
                ),

            cantidad:
                numero(
                    fila[4]
                ),

            color:
                texto(
                    fila[5]
                ),

            movimiento:
                texto(
                    fila[6]
                ),

            reparacion:
                texto(
                    fila[7]
                ),

            sin_armar:
                texto(
                    fila[8]
                ),

            muestra:
                texto(
                    fila[9]
                ),

            hora:
                texto(
                    fila[10]
                ),

            pagado:
                texto(
                    fila[11]
                ),

            finalizado:
                texto(
                    fila[12]
                ),

            boleta:
                texto(
                    fila[13]
                ),

            id_articulo:
                texto(
                    fila[14]
                ),

            precio_pago:
                texto(
                    fila[15]
                ),

            importe_pago:
                texto(
                    fila[16]
                ),

            remis_pago:
                texto(
                    fila[17]
                )

        });

    }

    return movimientos;

}
// ============================================================
// LECTURA OPTIMIZADA Y PROTEGIDA PARA PAGOS
//
// OBJETIVO: evitar golpear Google Sheets varias veces cuando
// varios usuarios/endpoints consultan PAGOS al mismo tiempo.
//
// - UNA sola lectura A:R por consulta real.
// - Cache corta compartida para colapsar consultas simultáneas.
// - No hace lecturas adicionales al finalizar un ingreso.
// ============================================================

const CACHE_MOVIMIENTOS_PAGOS_MS = 1500;
let cacheMovimientosPagos = {
    datos: null,
    timestamp: 0,
    enCurso: null
};

function invalidarCacheMovimientosPagos(){
    cacheMovimientosPagos.datos = null;
    cacheMovimientosPagos.timestamp = 0;
}

async function obtenerMovimientosPagos({forzar = false} = {}) {

    if (!sheets) {
        throw new Error('Google Sheets no está conectado.');
    }

    const ahora = Date.now();

    if (
        !forzar &&
        cacheMovimientosPagos.datos &&
        (ahora - cacheMovimientosPagos.timestamp) < CACHE_MOVIMIENTOS_PAGOS_MS
    ) {
        return cacheMovimientosPagos.datos;
    }

    // Si ya hay una lectura real en curso, todos esperan la MISMA lectura.
    if (!forzar && cacheMovimientosPagos.enCurso) {
        return cacheMovimientosPagos.enCurso;
    }

    const lectura = (async () => {
        // Una sola petición a Google Sheets.
        const filas = await obtenerHoja('BD', 'A2:R');

        let ultima = filas.length;
        while (ultima > 0) {
            const fila = filas[ultima - 1] || [];
            const tieneId = texto(fila[0]);
            const tieneAlgo = fila.some(valor => texto(valor) !== '');
            if (tieneId || tieneAlgo) break;
            ultima--;
        }

        if (ultima <= 0) return [];

        // Igual que antes: buscamos el primer movimiento NO finalizado.
        // La columna M es índice 12 dentro de A:R.
        let inicio = 0;
        for (let i = 0; i < ultima; i++) {
            if (!esSi((filas[i] || [])[12])) {
                inicio = i;
                break;
            }
            inicio = ultima;
        }

        if (inicio >= ultima) return [];

        const movimientos = [];

        for (let i = inicio; i < ultima; i++) {
            const fila = filas[i] || [];
            const id = texto(fila[0]);
            if (!id) continue;

            movimientos.push({
                id,
                fila: i + 2,
                fecha: texto(fila[1]),
                taller: texto(fila[2]),
                articulo: texto(fila[3]),
                cantidad: numero(fila[4]),
                color: texto(fila[5]),
                movimiento: texto(fila[6]),
                reparacion: texto(fila[7]),
                sin_armar: texto(fila[8]),
                muestra: texto(fila[9]),
                hora: texto(fila[10]),
                pagado: texto(fila[11]),
                finalizado: texto(fila[12]),
                boleta: texto(fila[13]),
                id_articulo: texto(fila[14]),
                precio_pago: numero(fila[15]),
                importe_pago: numero(fila[16]),
                remis_pago: numero(fila[17])
            });
        }

        cacheMovimientosPagos.datos = movimientos;
        cacheMovimientosPagos.timestamp = Date.now();

        return movimientos;
    })();

    if (!forzar) {
        cacheMovimientosPagos.enCurso = lectura;
    }

    try {
        return await lectura;
    } finally {
        if (!forzar && cacheMovimientosPagos.enCurso === lectura) {
            cacheMovimientosPagos.enCurso = null;
        }
    }
}

// ============================================================
// OBTENER HISTORIAL DE PAGOS
//
// ENTRA
// PAGADO = SI
// FINALIZADO = SI
//
// NO MODIFICA NADA.
// SOLO LEE BD.
// ============================================================

function obtenerHistorialPagos(
    movimientos
) {

    return movimientos

        .filter(
            movimiento => {

                if (
                    normalizarTexto(
                        movimiento.movimiento
                    ) !==
                    'ENTRA'
                ) {

                    return false;
                }

                if (
                    !esSi(
                        movimiento.pagado
                    )
                ) {

                    return false;
                }

                if (
                    !esSi(
                        movimiento.finalizado
                    )
                ) {

                    return false;
                }

                if (
                    !texto(
                        movimiento.taller
                    )
                ) {

                    return false;
                }

                return true;

            }
        )

        .map(
            movimiento => ({

                ...movimiento,

                tipo_pago:
                    obtenerTipoPago(
                        movimiento
                    ),

                abonable:
                    obtenerTipoPago(
                        movimiento
                    ) ===
                    'NORMAL',

                orden:
                    fechaHoraParaOrden(
                        movimiento.fecha,
                        movimiento.hora
                    )

            })
        )

        .sort(
            (
                a,
                b
            ) => {

                if (
                    a.orden !==
                    b.orden
                ) {

                    return (
                        b.orden -
                        a.orden
                    );

                }

                return (
                    Number(b.id) -
                    Number(a.id)
                );

            }
        );

}


// ============================================================
// SIGUIENTE ID
//
// La BD es escrita exclusivamente por este servidor. Leemos A:A
// una sola vez para inicializar el contador y luego entregamos
// los IDs desde memoria. Esto evita una lectura completa de BD por
// cada artículo cuando entran varios movimientos seguidos.
// ============================================================

let siguienteIdBD = null;
let inicializandoSiguienteIdBD = null;

async function obtenerSiguienteID() {

    if (siguienteIdBD === null) {

        if (!inicializandoSiguienteIdBD) {
            inicializandoSiguienteIdBD = (async () => {
                const filas = await obtenerHoja('BD', 'A:A');
                let maximo = 0;

                for (const fila of filas) {
                    const valor = Number(fila?.[0]);
                    if (Number.isFinite(valor) && valor > maximo) {
                        maximo = valor;
                    }
                }

                siguienteIdBD = maximo + 1;
            })();
        }

        try {
            await inicializandoSiguienteIdBD;
        } finally {
            inicializandoSiguienteIdBD = null;
        }
    }

    const id = siguienteIdBD;
    siguienteIdBD += 1;
    return id;
}

// ============================================================
// TALLERES
// ============================================================

async function obtenerTalleres() {

    const filas =
        await obtenerHoja(
            'TALLERES',
            'A2:A'
        );

    const talleres =
        [];

    for (
        let i = 0;
        i < filas.length;
        i++
    ) {

        const nombre =
            texto(
                filas[i]?.[0]
            );

        if (!nombre) {

            continue;

        }

        const filaReal =
            i + 2;

        talleres.push({

            id:
                String(
                    filaReal
                ),

            fila:
                filaReal,

            nombre:
                nombre,

            activo:
                true

        });

    }

    talleres.sort(
        (a, b) =>
            a.nombre.localeCompare(
                b.nombre,
                'es',
                {
                    sensitivity:
                        'base'
                }
            )
    );

    return talleres;

}

// ============================================================
// COLORES
// ============================================================

async function obtenerColores() {

    const filas =
        await obtenerHoja(
            'COLORES',
            'A2:A'
        );

    const colores =
        [];

    for (
        let i = 0;
        i < filas.length;
        i++
    ) {

        const nombre =
            texto(
                filas[i]?.[0]
            );

        if (!nombre) {

            continue;

        }

        const filaReal =
            i + 2;

        colores.push({

            id:
                String(
                    filaReal
                ),

            fila:
                filaReal,

            nombre:
                nombre,

            activo:
                true

        });

    }

    return colores;

}

// ============================================================
// COLOR MATERIAL
// ============================================================

async function obtenerColoresMaterial() {

    // COLOR MATERIAL vive en la columna B de la hoja COLORES.
    const filas =
        await obtenerHoja(
            'COLORES',
            'B2:B'
        );

    const colores =
        [];

    for (
        let i = 0;
        i < filas.length;
        i++
    ) {

        const nombre =
            texto(
                filas[i]?.[0]
            );

        if (!nombre) {

            continue;

        }

        const filaReal =
            i + 2;

        colores.push({

            id:
                String(
                    filaReal
                ),

            fila:
                filaReal,

            nombre:
                nombre,

            activo:
                true

        });

    }

    colores.sort(
        (a, b) =>
            a.nombre.localeCompare(
                b.nombre,
                'es',
                {
                    sensitivity:
                        'base'
                }
            )
    );

    return colores;

}

// ============================================================
// API TALLERES
// ============================================================


// ============================================================
// DIAGNÓSTICO — RELOJ BUENOS AIRES
// ============================================================
app.get('/api/reloj-argentina',(req,res)=>{
    try{
        const reloj=obtenerFechaHoraBuenosAires();
        res.json({
            success:true,
            zonaHoraria:'America/Argentina/Buenos_Aires',
            ...reloj
        });
    }catch(error){
        res.status(500).json({
            success:false,
            error:error.message
        });
    }
});

app.get(
    '/api/talleres',
    async (
        req,
        res
    ) => {

        try {

            const talleres =
                await obtenerTalleres();

            res.json(
                talleres
            );

        } catch (error) {

            console.error(
                '❌ ERROR TALLERES:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API COLORES
// ============================================================

app.get(
    '/api/colores',
    async (
        req,
        res
    ) => {

        try {

            const colores =
                await obtenerColores();

            res.json(
                colores
            );

        } catch (error) {

            console.error(
                '❌ ERROR COLORES:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API COLOR MATERIAL
// ============================================================

app.get(
    '/api/colores-material',
    async (
        req,
        res
    ) => {

        try {

            const colores =
                await obtenerColoresMaterial();

            res.json(
                colores
            );

        } catch (error) {

            console.error(
                '❌ ERROR COLOR MATERIAL:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// COLOR MATERIAL - AGREGAR
// ============================================================

app.post(
    '/api/colores-material',
    async (
        req,
        res
    ) => {

        try {

            const nombre =
                normalizarTexto(
                    req.body?.nombre
                );

            if (!nombre) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nombre de color material requerido.'

                });

            }

            const colores =
                await obtenerColoresMaterial();

            const existe =
                colores.some(
                    color =>
                        normalizarTexto(
                            color.nombre
                        ) ===
                        nombre
                );

            if (existe) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'El color material ya existe.'

                });

            }

            // ========================================================
            // IMPORTANTE: COLOR MATERIAL vive en la COLUMNA B de
            // la hoja COLORES. No insertamos filas porque eso movería
            // también la lista de COLORES de la columna A.
            // Buscamos la última celda ocupada de B y escribimos
            // directamente en la siguiente fila.
            // ========================================================

            const hojaColores =
                await obtenerHoja(
                    'COLORES',
                    'B2:B'
                );

            let filaDestino = 2;

            for (let i = 0; i < hojaColores.length; i++) {
                const valor = texto(hojaColores[i]?.[0]);
                if (valor) {
                    filaDestino = i + 3;
                }
            }

            await sheets.spreadsheets.values.update({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                range:
                    `'COLORES'!B${filaDestino}`,

                valueInputOption:
                    'USER_ENTERED',

                requestBody: {
                    values: [[nombre]]
                }

            });

            // Ordenamos SOLAMENTE la columna B.
            // La columna A queda completamente intacta.
            const sheetId =
                await obtenerSheetId(
                    'COLORES'
                );

            const cantidadFilasB =
                Math.max(filaDestino - 1, 1);

            await sheets.spreadsheets.batchUpdate({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                requestBody: {
                    requests: [
                        {
                            sortRange: {
                                range: {
                                    sheetId,
                                    startRowIndex: 1,
                                    endRowIndex: filaDestino,
                                    startColumnIndex: 1,
                                    endColumnIndex: 2
                                },
                                sortSpecs: [
                                    {
                                        dimensionIndex: 1,
                                        sortOrder: 'ASCENDING'
                                    }
                                ]
                            }
                        }
                    ]
                }

            });

            res.json({

                success:
                    true,

                mensaje:
                    'Color material agregado y ordenado correctamente.',

                color:
                    nombre

            });

        } catch (error) {

            console.error(
                '❌ ERROR AGREGANDO COLOR MATERIAL:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// COLOR MATERIAL - ELIMINAR
// ============================================================

app.delete(
    '/api/colores-material/:id',
    async (
        req,
        res
    ) => {

        try {

            const fila =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    fila
                ) ||
                fila < 2
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'ID de color material inválido.'

                });

            }

            // No borramos la fila completa porque la columna A
            // contiene los colores actuales. Solo limpiamos B.
            await sheets.spreadsheets.values.clear({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                range:
                    `'COLORES'!B${fila}:B${fila}`

            });

            res.json({

                success:
                    true,

                mensaje:
                    'Color material eliminado.'

            });

        } catch (error) {

            console.error(
                '❌ ERROR ELIMINANDO COLOR MATERIAL:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// ADMIN TALLERES - AGREGAR
// ============================================================

app.post(
    '/api/admin/talleres',
    async (
        req,
        res
    ) => {

        try {

            // =================================================
            // TOMAR EL NOMBRE Y CONVERTIRLO A MAYÚSCULAS
            // =================================================

            const nombre =
                normalizarTexto(
                    req.body?.nombre
                );

            if (!nombre) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nombre de taller requerido.'

                });

            }

            // =================================================
            // LEER LOS TALLERES ACTUALES
            // =================================================

            const talleres =
                await obtenerTalleres();

            // =================================================
            // COMPROBAR SI YA EXISTE
            // =================================================

            const existe =
                talleres.some(
                    taller =>
                        normalizarTexto(
                            taller.nombre
                        ) ===
                        nombre
                );

            if (existe) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'El taller ya existe.'

                });

            }

            // =================================================
            // AGREGAR SIEMPRE EN MAYÚSCULAS
            // =================================================

            await agregarFila(
                'TALLERES',
                [
                    nombre
                ]
            );

            // =================================================
            // VOLVER A LEER TODOS LOS TALLERES
            // =================================================
            // Esto nos permite normalizar también los que
            // pudieran haber quedado anteriormente en minúscula.

            const talleresActuales =
                await obtenerTalleres();

            // =================================================
            // NORMALIZAR TODOS LOS NOMBRES
            // =================================================

            for (
                const taller
                of talleresActuales
            ) {

                const nombreMayuscula =
                    normalizarTexto(
                        taller.nombre
                    );

                if (
                    nombreMayuscula !==
                    taller.nombre
                ) {

                    await sheets.spreadsheets.values.update({

                        spreadsheetId:
                            GOOGLE_SHEET_ID,

                        range:
                            `TALLERES!A${taller.fila}`,

                        valueInputOption:
                            'USER_ENTERED',

                        requestBody: {

                            values: [
                                [
                                    nombreMayuscula
                                ]
                            ]

                        }

                    });

                }

            }

            // =================================================
            // OBTENER ID DE LA HOJA TALLERES
            // =================================================

            const sheetId =
                await obtenerSheetId(
                    'TALLERES'
                );

            // =================================================
            // ORDENAR ALFABÉTICAMENTE
            //
            // A1 = ENCABEZADO
            // A2 EN ADELANTE = TALLERES
            // =================================================

            const ultimaFila =
                talleresActuales.length + 2;

            await sheets.spreadsheets.batchUpdate({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                requestBody: {

                    requests: [

                        {

                            sortRange: {

                                range: {

                                    sheetId:
                                        sheetId,

                                    startRowIndex:
                                        1,

                                    endRowIndex:
                                        ultimaFila,

                                    startColumnIndex:
                                        0,

                                    endColumnIndex:
                                        1

                                },

                                sortSpecs: [

                                    {

                                        dimensionIndex:
                                            0,

                                        sortOrder:
                                            'ASCENDING'

                                    }

                                ]

                            }

                        }

                    ]

                }

            });

            // =================================================
            // RESPUESTA
            // =================================================

            res.json({

                success:
                    true,

                mensaje:
                    'Taller agregado y ordenado correctamente.',

                taller:
                    nombre

            });

        } catch (error) {

            console.error(
                '❌ ERROR AGREGANDO TALLER:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// ADMIN COLORES - AGREGAR
// ============================================================

app.post(
    '/api/admin/colores',
    async (
        req,
        res
    ) => {

        try {

            // =================================================
            // TOMAR EL NOMBRE Y CONVERTIRLO A MAYÚSCULAS
            // =================================================

            const nombre =
                normalizarTexto(
                    req.body?.nombre
                );

            if (!nombre) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nombre de color requerido.'

                });

            }

            // =================================================
            // LEER LOS COLORES ACTUALES
            // =================================================

            const colores =
                await obtenerColores();

            // =================================================
            // COMPROBAR SI YA EXISTE
            // =================================================

            const existe =
                colores.some(
                    color =>
                        normalizarTexto(
                            color.nombre
                        ) ===
                        nombre
                );

            if (existe) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'El color ya existe.'

                });

            }

            // =================================================
            // AGREGAR SIEMPRE EN MAYÚSCULAS
            // =================================================

            // IMPORTANTE: COLORES usa la columna A y COLOR MATERIAL usa la B.
            // No insertamos una fila completa porque eso desplazaría la columna B.
            const filasColores =
                await obtenerHoja(
                    'COLORES',
                    'A2:A'
                );

            const filaNuevaColor =
                filasColores.length + 2;

            await sheets.spreadsheets.values.update({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                range:
                    `COLORES!A${filaNuevaColor}`,

                valueInputOption:
                    'USER_ENTERED',

                requestBody: {

                    values: [
                        [nombre]
                    ]

                }

            });

            // =================================================
            // VOLVER A LEER TODOS LOS COLORES
            // =================================================

            const coloresActuales =
                await obtenerColores();

            // =================================================
            // NORMALIZAR TODOS LOS NOMBRES
            // =================================================

            for (
                const color
                of coloresActuales
            ) {

                const nombreMayuscula =
                    normalizarTexto(
                        color.nombre
                    );

                if (
                    nombreMayuscula !==
                    color.nombre
                ) {

                    await sheets.spreadsheets.values.update({

                        spreadsheetId:
                            GOOGLE_SHEET_ID,

                        range:
                            `COLORES!A${color.fila}`,

                        valueInputOption:
                            'USER_ENTERED',

                        requestBody: {

                            values: [
                                [
                                    nombreMayuscula
                                ]
                            ]

                        }

                    });

                }

            }

            // =================================================
            // OBTENER ID DE LA HOJA COLORES
            // =================================================

            const sheetId =
                await obtenerSheetId(
                    'COLORES'
                );

            // =================================================
            // ORDENAR ALFABÉTICAMENTE
            //
            // A1 = ENCABEZADO
            // A2 EN ADELANTE = COLORES
            // =================================================

            const ultimaFila =
                coloresActuales.length + 2;

            await sheets.spreadsheets.batchUpdate({

                spreadsheetId:
                    GOOGLE_SHEET_ID,

                requestBody: {

                    requests: [

                        {

                            sortRange: {

                                range: {

                                    sheetId:
                                        sheetId,

                                    startRowIndex:
                                        1,

                                    endRowIndex:
                                        ultimaFila,

                                    startColumnIndex:
                                        0,

                                    endColumnIndex:
                                        1

                                },

                                sortSpecs: [

                                    {

                                        dimensionIndex:
                                            0,

                                        sortOrder:
                                            'ASCENDING'

                                    }

                                ]

                            }

                        }

                    ]

                }

            });

            // =================================================
            // RESPUESTA
            // =================================================

            res.json({

                success:
                    true,

                mensaje:
                    'Color agregado y ordenado correctamente.',

                color:
                    nombre

            });

        } catch (error) {

            console.error(
                '❌ ERROR AGREGANDO COLOR:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// ADMIN TALLERES - ELIMINAR
// ============================================================

app.delete(
    '/api/admin/talleres/:id',
    async (
        req,
        res
    ) => {

        try {

            const fila =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    fila
                ) ||
                fila < 2
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'ID de taller inválido.'

                });

            }

            await borrarFila(
                'TALLERES',
                fila
            );

            res.json({

                success:
                    true,

                mensaje:
                    'Taller eliminado.'

            });

        } catch (error) {

            console.error(
                '❌ ERROR ELIMINANDO TALLER:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// ADMIN COLORES - ELIMINAR
// ============================================================

app.delete(
    '/api/admin/colores/:id',
    async (
        req,
        res
    ) => {

        try {

            const fila =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    fila
                ) ||
                fila < 2
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'ID de color inválido.'

                });

            }

            await borrarFila(
                'COLORES',
                fila
            );

            res.json({

                success:
                    true,

                mensaje:
                    'Color eliminado.'

            });

        } catch (error) {

            console.error(
                '❌ ERROR ELIMINANDO COLOR:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// ARTÍCULOS
// ============================================================

app.get(
    '/api/articulos',
    async (
        req,
        res
    ) => {

        try {

            const filas =
                await obtenerHoja(
                    'BD',
                    'D2:D'
                );

            const vistos =
                new Set();

            const articulos =
                [];

            for (
                const fila
                of filas
            ) {

                const codigo =
                    texto(
                        fila?.[0]
                    );

                if (!codigo) {

                    continue;

                }

                const clave =
                    normalizarTexto(
                        codigo
                    );

                if (
                    vistos.has(
                        clave
                    )
                ) {

                    continue;

                }

                vistos.add(
                    clave
                );

                articulos.push({

                    id:
                        codigo,

                    codigo:
                        codigo,

                    descripcion:
                        ''

                });

            }

            res.json(
                articulos
            );

        } catch (error) {

            console.error(
                '❌ ERROR ARTÍCULOS:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// OBTENER TALLER POR ID
// ============================================================

async function obtenerTallerPorId(
    id
) {

    const fila =
        Number(
            id
        );

    if (
        Number.isInteger(
            fila
        ) &&
        fila >= 2
    ) {

        const datos =
            await obtenerHoja(
                'TALLERES',
                `A${fila}`
            );

        const nombre =
            texto(
                datos[0]?.[0]
            );

        if (nombre) {

            return {

                id:
                    String(
                        fila
                    ),

                fila:
                    fila,

                nombre:
                    nombre

            };

        }

    }

    const talleres =
        await obtenerTalleres();

    return talleres.find(
        taller =>
            normalizarTexto(
                taller.nombre
            ) ===
            normalizarTexto(
                id
            )
    ) || null;

}// ============================================================
// CLAVE PENDIENTE
// ============================================================

function clavePendiente(
    movimiento
) {

    const muestra =
        esSi(
            movimiento.muestra
        ) ||
        normalizarTexto(
            movimiento.color
        ) ===
        'MUESTRA';

    return [

        normalizarTexto(
            movimiento.taller
        ),

        normalizarTexto(
            movimiento.articulo
        ),

        normalizarTexto(
            movimiento.color
        ),

        esSi(
            movimiento.reparacion
        )
            ? 'SI'
            : 'NO',

        muestra
            ? 'SI'
            : 'NO'

    ].join('|');

}

// ============================================================
// CALCULAR PENDIENTES
// ============================================================

function calcularPendientes(
    movimientos,
    tallerNombre
) {

    const nombreTaller =
        normalizarTexto(tallerNombre);

    /*
    ============================================================
    REGLA DE LOTES — IMPORTANTE

    Cada SALE es un lote INDEPENDIENTE.

    Si el taller hizo:
        20/08 -> 1915 x 40 NEGRO  (tarea A)
        26/08 -> 1915 x 80 NEGRO  (tarea B)

    y luego devuelve:
        25/08 -> 39
        02/09 -> 79

    el resultado debe ser:
        1915 | 1 | NEGRO | 20/08/2026
        1915 | 1 | NEGRO | 26/08/2026

    NUNCA:
        1915 | 2 | NEGRO | una sola fecha

    La columna O de BD (id_articulo) contiene el
    ID_ARTICULO_TAREA cuando la SALE provino de una tarea.
    Lo conservamos como identidad del lote.
    Para una SALE manual sin tarea usamos el ID del movimiento.

    Las ENTRAS se aplican FIFO sobre los lotes compatibles:
    artículo + color + reparación + muestra.
    ============================================================
    */

    const ventas = [];

    const movimientosOrdenados =
        [...(Array.isArray(movimientos) ? movimientos : [])]
        .filter(movimiento =>
            normalizarTexto(movimiento.taller) === nombreTaller
        )
        .sort((a, b) => {
            const oa = fechaHoraParaOrden(a.fecha, a.hora);
            const ob = fechaHoraParaOrden(b.fecha, b.hora);
            if (oa !== ob) return oa - ob;
            return Number(a.id) - Number(b.id);
        });

    for (const movimiento of movimientosOrdenados) {

        const cantidad =
            numero(movimiento.cantidad);

        if (cantidad <= 0) continue;

        const tipo =
            normalizarTexto(movimiento.movimiento);

        const esMuestraMovimiento =
            esSi(movimiento.muestra) ||
            normalizarTexto(movimiento.color) === 'MUESTRA';

        const esReparacionMovimiento =
            esSi(movimiento.reparacion);

        const clave =
            clavePendiente({
                ...movimiento,
                muestra: esMuestraMovimiento ? 'SI' : 'NO',
                reparacion: esReparacionMovimiento ? 'SI' : 'NO'
            });

        if (tipo === 'SALE') {

            /*
            Cada SALE entra SIEMPRE como un objeto propio.
            NO agrupamos por artículo/color.
            */
            ventas.push({
                id: String(movimiento.id),
                lote_id: String(
                    movimiento.id_articulo || movimiento.id
                ),
                id_articulo_tarea: String(
                    movimiento.id_articulo || ''
                ),
                fila: movimiento.fila,
                taller_id: '',
                taller: movimiento.taller,
                articulo_id: movimiento.articulo,
                articulo_codigo: movimiento.articulo,
                codigo: movimiento.articulo,
                color: movimiento.color,
                cantidad_salida: cantidad,
                cantidad_pendiente: cantidad,
                fecha_salida: movimiento.fecha,
                hora_salida: movimiento.hora,
                reparacion: esReparacionMovimiento ? 'SI' : 'NO',
                muestra: esMuestraMovimiento ? 'SI' : 'NO',
                sin_armar: movimiento.sin_armar,
                clave: clave
            });

            continue;
        }

        if (tipo === 'ENTRA') {

            let restante = cantidad;

            /*
            FIFO: una entrada descuenta primero el lote más viejo
            que coincida. Como cada SALE está separado, una entrada
            nunca fusiona dos tareas: solo puede dejar saldo en cada
            lote individual.
            */
            for (const venta of ventas) {

                if (restante <= 0) break;
                if (venta.clave !== clave) continue;
                if (venta.cantidad_pendiente <= 0) continue;

                const descontar = Math.min(
                    venta.cantidad_pendiente,
                    restante
                );

                venta.cantidad_pendiente -= descontar;
                restante -= descontar;
            }
        }
    }

    return ventas.filter(
        venta => venta.cantidad_pendiente > 0
    );

}

// ============================================================
// API FINALIZAR INGRESO
// ============================================================
// El operador de INDEX puede cerrar la visita del taller.
// No modifica BD: solamente dispara el aviso a PAGOS.
// ============================================================
app.post(
    '/api/talleres/:tallerId/finalizar-ingreso',
    async (req, res) => {
        try {
            const taller = await obtenerTallerPorId(req.params.tallerId);

            if (!taller) {
                return res.status(404).json({
                    success: false,
                    error: 'Taller no encontrado.'
                });
            }

            // El botón FINALIZAR se habilita desde INDEX cuando la visita
            // ya tiene movimientos cargados. No hacemos otra lectura de BD
            // acá: el objetivo es no generar ráfagas innecesarias contra Sheets.
            // V1.23: los avisos del instalador salen directamente desde PAGOS.
            // No hacemos lecturas/avisos extra desde esta ruta.
            encolarAvisoPagos('INGRESO', taller.nombre);

            return res.json({
                success: true,
                taller: taller.nombre,
                mensaje: 'Ingreso finalizado y PAGOS avisado correctamente.'
            });

        } catch (error) {
            console.error('❌ ERROR FINALIZANDO INGRESO:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

// ============================================================
// API PENDIENTES
// ============================================================

app.get(
    '/api/talleres/:tallerId/pendientes',
    async (
        req,
        res
    ) => {

        try {

            const taller =
                await obtenerTallerPorId(
                    req.params.tallerId
                );

            if (!taller) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'Taller no encontrado.'

                });

            }

            const movimientos =
                await obtenerMovimientos();

            const pendientes =
                calcularPendientes(

                    movimientos,

                    taller.nombre

                );

            for (
                const item
                of pendientes
            ) {

                item.taller_id =
                    taller.id;

            }

            const normales =
                pendientes.filter(
                    item =>
                        item.reparacion !== 'SI' &&
                        item.muestra !== 'SI'
                );

            const reparaciones =
                pendientes.filter(
                    item =>
                        item.reparacion === 'SI'
                );

            const muestras =
                pendientes.filter(
                    item =>
                        item.muestra === 'SI'
                );

            res.json({

                success:
                    true,

                pendientes:
                    normales,

                reparaciones:
                    reparaciones,

                muestras:
                    muestras

            });

        } catch (error) {

            console.error(
                '❌ ERROR CARGANDO PENDIENTES:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// PAGOS - MOVIMIENTOS PENDIENTES
// ============================================================

function obtenerTipoPago(
    movimiento
) {

    if (
        esSi(
            movimiento.reparacion
        )
    ) {

        return 'REPARACION';

    }

    if (
        esSi(
            movimiento.muestra
        ) ||
        normalizarTexto(
            movimiento.color
        ) ===
        'MUESTRA'
    ) {

        return 'MUESTRA';

    }

    if (
        esSi(
            movimiento.sin_armar
        )
    ) {

        return 'S/ARMAR';

    }

    return 'NORMAL';

}

// ============================================================
// REGLA DE REMIS POR VISITA
// ============================================================
// Solo una SALE de producción puede ser remis.
// MUESTRA y REPARACION nunca son remis aislado.
// Una SALE de producción deja de ser aislada si el taller
// entregó mercadería (ENTRA) hasta 30 minutos antes en la
// misma fecha. Eso representa la misma visita.
function esSalidaProduccionParaRemis(
    movimiento
) {

    if (
        normalizarTexto(movimiento?.movimiento) !== 'SALE'
    ) {
        return false;
    }

    const tipo =
        obtenerTipoPago(
            movimiento
        );

    return (
        tipo === 'NORMAL' ||
        tipo === 'S/ARMAR'
    );

}


function ingresoAsociadoRemis30Min(
    salida,
    movimientos
) {

    if (
        !esSalidaProduccionParaRemis(
            salida
        )
    ) {
        return null;
    }

    const fechaSalida =
        normalizarTexto(salida.fecha);

    const horaSalida =
        segundosHora(salida.hora);

    if (
        !fechaSalida ||
        horaSalida === null
    ) {
        return null;
    }

    return movimientos
        .filter(
            movimiento =>
                normalizarTexto(movimiento.movimiento) === 'ENTRA' &&
                normalizarTexto(movimiento.taller) ===
                    normalizarTexto(salida.taller) &&
                normalizarTexto(movimiento.fecha) === fechaSalida
        )
        .map(
            movimiento => ({
                movimiento,
                segundos: segundosHora(movimiento.hora)
            })
        )
        .filter(
            item =>
                item.segundos !== null &&
                item.segundos <= horaSalida &&
                horaSalida - item.segundos <= 30 * 60
        )
        .sort(
            (a, b) =>
                b.segundos - a.segundos
        )[0]?.movimiento || null;

}


function esSalidaRemisAisladaServidor(
    movimiento,
    movimientos
) {

    if (
        !esSalidaProduccionParaRemis(
            movimiento
        )
    ) {
        return false;
    }

    return !ingresoAsociadoRemis30Min(
        movimiento,
        movimientos
    );

}


function obtenerMovimientosPendientesPago(
    movimientos
) {

    return movimientos

        .filter(
            movimiento => {

                const esEntrada =
                    normalizarTexto(
                        movimiento.movimiento
                    ) ===
                    'ENTRA';

                const esRemis =
                    normalizarTexto(
                        movimiento.movimiento
                    ) ===
                    'SALE' &&
                    texto(
                        movimiento.boleta
                    ) !== '';

                // PAGOS incluye:
                // 1) ENTRAS pendientes normales.
                // 2) SALIDAS AISLADAS que tienen BOLETA.
                //
                // Las SALE normales siguen afuera.
                if (
                    !esEntrada &&
                    !esRemis
                ) {

                    return false;

                }

                if (
                    esSi(
                        movimiento.finalizado
                    )
                ) {

                    return false;

                }

                if (
                    esSi(
                        movimiento.pagado
                    )
                ) {

                    return false;

                }

                if (
                    numero(
                        movimiento.cantidad
                    ) <= 0
                ) {

                    return false;

                }

                if (
                    !texto(
                        movimiento.taller
                    )
                ) {

                    return false;

                }

                return true;

            }
        )

        .map(
            movimiento => {

                const esRemis =
                    normalizarTexto(
                        movimiento.movimiento
                    ) ===
                    'SALE' &&
                    texto(
                        movimiento.boleta
                    ) !== '';

                const tipo =
                    esRemis
                        ? 'REMIS'
                        : obtenerTipoPago(
                            movimiento
                        );

                return {

                    id:
                        movimiento.id,

                    fila:
                        movimiento.fila,

                    fecha:
                        movimiento.fecha,

                    hora:
                        movimiento.hora,

                    taller:
                        movimiento.taller,

                    articulo:
                        movimiento.articulo,

                    cantidad:
                        movimiento.cantidad,

                    color:
                        movimiento.color,

                    movimiento:
                        movimiento.movimiento,

                    reparacion:
                        movimiento.reparacion,

                    sin_armar:
                        movimiento.sin_armar,

                    muestra:
                        movimiento.muestra,

                    pagado:
                        movimiento.pagado,

                    finalizado:
                        movimiento.finalizado,

                    boleta:
                        movimiento.boleta || '',

                    tipo_pago:
                        tipo,

                    // Un remis aislado es abonable.
                    abonable:
                        esRemis
                            ? true
                            : tipo === 'NORMAL',

                    salida_aislada:
                        esRemis,

                    orden:
                        fechaHoraParaOrden(
                            movimiento.fecha,
                            movimiento.hora
                        )

                };

            }
        )

        .sort(
            (a, b) => {

                if (
                    a.orden !==
                    b.orden
                ) {

                    return (
                        a.orden -
                        b.orden
                    );

                }

                return (
                    Number(a.id) -
                    Number(b.id)
                );

            }
        );

}

// ============================================================
// API PAGOS - BOLETA DE SALIDA AISLADA
// ============================================================

app.post(
    '/api/pagos/boleta-salida',
    async (
        req,
        res
    ) => {

        const id =
            texto(
                req.body?.id
            );

        if (!id) {

            return res.status(400).json({

                success:
                    false,

                error:
                    'ID de salida requerido.'

            });

        }

        let movimientosIniciales;
        let movimientoInicial;

        try {

            movimientosIniciales =
                await obtenerMovimientos();

            movimientoInicial =
                movimientosIniciales.find(
                    item =>
                        item.id === id
                );

            if (!movimientoInicial) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'No se encontró la salida.'

                });

            }

            if (
                texto(
                    movimientoInicial.boleta
                )
            ) {

    
            // Avisar al INDEX si la boleta generó un pago pendiente.
            // V1.23: no generar lecturas adicionales de Sheets para avisos.

            return res.json({

                    success:
                        true,

                    numeroBoleta:
                        movimientoInicial.boleta,

                    yaExistia:
                        true,

                    agrupado:
                        false

                });

            }

        } catch (error) {

            console.error(
                '❌ ERROR LEYENDO SALIDA PARA REMIS:',
                error
            );

            return res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

        const claveRemis =
            `${normalizarTexto(movimientoInicial.taller)}|${normalizarTexto(movimientoInicial.fecha)}`;

        // ======================================================
        // SERIALIZAR POR TALLER + FECHA
        // ======================================================
        // Si dos salidas llegan casi juntas, la segunda espera a
        // que la primera haya escrito la boleta en Google Sheets.
        // Así las dos quedan dentro del mismo REMIS.
        // ======================================================

        const anterior =
            locksRemis.get(claveRemis) ||
            Promise.resolve();

        let liberar;

        const actual =
            new Promise(
                resolve => {
                    liberar = resolve;
                }
            );

        const promesaLock =
            anterior.then(
                () => actual
            );

        locksRemis.set(
            claveRemis,
            promesaLock
        );

        await anterior;

        try {

            // Volvemos a leer BD DESPUÉS de esperar el lock.
            // Esto es fundamental para ver la boleta que pudo
            // haber creado la salida anterior.
            const movimientos =
                await obtenerMovimientos();

            const movimiento =
                movimientos.find(
                    item =>
                        item.id === id
                );

            if (!movimiento) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'No se encontró la salida.'

                });

            }

            if (
                !esSalidaProduccionParaRemis(
                    movimiento
                ) ||
                !esSalidaRemisAisladaServidor(
                    movimiento,
                    movimientos
                )
            ) {

                return res.json({

                    success:
                        true,

                    numeroBoleta:
                        '',

                    yaExistia:
                        false,

                    agrupado:
                        false,

                    ignorado:
                        true

                });

            }

            if (
                texto(
                    movimiento.boleta
                )
            ) {

                return res.json({

                    success:
                        true,

                    numeroBoleta:
                        movimiento.boleta,

                    yaExistia:
                        true,

                    agrupado:
                        true

                });

            }

            // ==================================================
            // REMIS ABIERTO DEL MISMO TALLER Y MISMO DÍA
            // ==================================================

            const salidasDelDia =
                movimientos.filter(
                    item =>
                        esSalidaRemisAisladaServidor(
                            item,
                            movimientos
                        ) &&
                        normalizarTexto(item.taller) ===
                            normalizarTexto(movimiento.taller) &&
                        normalizarTexto(item.fecha) ===
                            normalizarTexto(movimiento.fecha)
                );

            const horaMovimiento =
                segundosHora(
                    movimiento.hora
                );

            const boletasAbiertas =
                salidasDelDia
                    .filter(
                        item =>
                            texto(item.boleta) &&
                            !esSi(item.pagado) &&
                            !esSi(item.finalizado) &&
                            horaMovimiento !== null &&
                            segundosHora(item.hora) !== null &&
                            Math.abs(
                                horaMovimiento - segundosHora(item.hora)
                            ) <= 30 * 60
                    )
                    .map(
                        item => Number(item.boleta)
                    )
                    .filter(
                        numero =>
                            Number.isInteger(numero) &&
                            numero > 0
                    );

            const numerosExistentes =
                salidasDelDia
                    .map(
                        item =>
                            Number(
                                item.boleta
                            )
                    )
                    .filter(
                        numero =>
                            Number.isInteger(
                                numero
                            ) &&
                            numero > 0
                    );

            let numeroBoleta;
            let agrupado = false;

            if (
                boletasAbiertas.length
            ) {

                // Si ya hay un REMIS abierto, TODO retiro nuevo
                // del mismo taller/día usa ese mismo número.
                numeroBoleta =
                    Math.min(
                        ...boletasAbiertas
                    );

                agrupado =
                    true;

                // Si por una versión anterior quedaron dos números
                // abiertos (ej. BOLETA 1 y BOLETA 2), los unificamos
                // en el menor. Esto evita volver a generar dos REMISES
                // por error.
                const filasParaUnificar =
                    salidasDelDia.filter(
                        item =>
                            item.fila !==
                            movimiento.fila &&

                            texto(
                                item.boleta
                            ) &&

                            !esSi(
                                item.pagado
                            ) &&

                            !esSi(
                                item.finalizado
                            ) &&

                            horaMovimiento !== null &&
                            segundosHora(item.hora) !== null &&
                            Math.abs(
                                horaMovimiento - segundosHora(item.hora)
                            ) <= 30 * 60 &&

                            String(
                                item.boleta
                            ) !==
                            String(
                                numeroBoleta
                            )
                    );

                for (
                    const item
                    of filasParaUnificar
                ) {

                    await actualizarFila(
                        'BD',
                        item.fila,
                        [

                            item.id,
                            item.fecha,
                            item.taller,
                            item.articulo,
                            String(item.cantidad),
                            item.color,
                            item.movimiento,
                            item.reparacion,
                            item.sin_armar,
                            item.muestra,
                            item.hora,
                            item.pagado,
                            item.finalizado,
                            String(numeroBoleta)

                        ]
                    );

                }

            } else {

                // No hay REMIS abierto: se crea el siguiente número.
                numeroBoleta =
                    numerosExistentes.length
                        ? Math.max(
                            ...numerosExistentes
                        ) + 1
                        : 1;

            }

            await actualizarFila(
                'BD',
                movimiento.fila,
                [

                    movimiento.id,
                    movimiento.fecha,
                    movimiento.taller,
                    movimiento.articulo,
                    String(
                        movimiento.cantidad
                    ),
                    movimiento.color,
                    movimiento.movimiento,
                    movimiento.reparacion,
                    movimiento.sin_armar,
                    movimiento.muestra,
                    movimiento.hora,
                    movimiento.pagado,
                    movimiento.finalizado,
                    String(
                        numeroBoleta
                    )

                ]
            );

            console.log(
                '🚚 REMIS ASIGNADO:',
                {
                    taller:
                        movimiento.taller,
                    fecha:
                        movimiento.fecha,
                    numeroBoleta,
                    agrupado
                }
            );

            // Solo una salida aislada que crea un REMIS nuevo
            // genera la notificación "Nuevo REMIS".
            if(!agrupado){
                encolarAvisoPagos('REMIS_AISLADO', movimiento.taller);
            }

            return res.json({

                success:
                    true,

                numeroBoleta:
                    String(
                        numeroBoleta
                    ),

                agrupado

            });

        } catch (error) {

            console.error(
                '❌ ERROR BOLETA SALIDA AISLADA:',
                error
            );

            return res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        } finally {

            liberar();

            if (
                locksRemis.get(
                    claveRemis
                ) ===
                promesaLock
            ) {

                locksRemis.delete(
                    claveRemis
                );

            }

        }

    }
);

// ============================================================
// API PAGOS - LISTADO GENERAL
// ============================================================

// ============================================================
// API PAGOS - AVISO EN TIEMPO REAL
// ============================================================

app.get(
    '/api/pagos/eventos',
    async (req, res) => {

        // IMPORTANTE: authMejorada ya exige permiso BD para esta ruta.
        // No se envían avisos a usuarios que no tengan BD.
        res.status(200);

        res.setHeader(
            'Content-Type',
            'text/event-stream'
        );

        res.setHeader(
            'Cache-Control',
            'no-cache, no-transform'
        );

        res.setHeader(
            'Connection',
            'keep-alive'
        );

        res.setHeader(
            'X-Accel-Buffering',
            'no'
        );

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        clientesAvisoPagos.add(res);

        // Estado actual al abrir INDEX.
        try {
            const movimientos = await obtenerMovimientosPagos();
            const estado = obtenerTalleresPendientesUnicos(movimientos);

            talleresPendientesAvisoAnterior = new Set(
                estado.talleres.map(t=>normalizarTexto(t))
            );

            res.write(
                `event: pagos\ndata: ${JSON.stringify({
                    pendientes: estado.talleres.length,
                    talleresPendientes: estado.talleres,
                    nuevosTalleres: [],
                    hayPendientes: estado.talleres.length > 0
                })}\n\n`
            );
        } catch (error) {
            console.error('⚠️ ERROR ESTADO INICIAL AVISO PAGOS:', error.message);
        }

        // Solo mantiene viva la conexión. NO consulta Google Sheets.
        const heartbeat = setInterval(() => {
            try {
                res.write(': keep-alive\n\n');
            } catch (_) {}
        }, 25000);

        req.on('close', () => {
            clearInterval(heartbeat);
            clientesAvisoPagos.delete(res);
        });
    }
);

// ============================================================
// API PAGOS - LISTADO GENERAL
// ============================================================


// ============================================================
// API PAGOS - COLA DE AVISOS DEL INSTALADOR
// ============================================================
// NO consulta Google Sheets. Lee/escribe solo memoria RAM del servidor.
// Requiere permiso PAGOS por authMejorada.

app.get(
    '/api/pagos/avisos',
    async (req, res) => {
        try{
            const aviso = obtenerAvisoPagosPendiente(req.usuarioGC);
            return res.json({
                success: true,
                aviso
            });
        }catch(error){
            console.error('❌ ERROR /api/pagos/avisos:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

app.post(
    '/api/pagos/avisos/ack',
    async (req, res) => {
        try{
            const ok = confirmarAvisoPagos(
                req.usuarioGC,
                req.body?.id
            );
            return res.json({
                success: ok,
                confirmado: ok
            });
        }catch(error){
            console.error('❌ ERROR /api/pagos/avisos/ack:', error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

app.get(
    '/api/pagos',
    async (
        req,
        res
    ) => {

        try {

            const movimientos =
                await obtenerMovimientosPagos();

            const pendientes =
                obtenerMovimientosPendientesPago(
                    movimientos
                );

            res.json({

                success:
                    true,

                movimientos:
                    pendientes

            });

        } catch (error) {

            console.error(
                '❌ ERROR /api/pagos:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API PAGOS - TALLERES
// ============================================================

app.get(
    '/api/pagos/talleres',
    async (
        req,
        res
    ) => {

        try {

            const movimientos =
                await obtenerMovimientosPagos();

            const pendientes =
                obtenerMovimientosPendientesPago(
                    movimientos
                );

            const mapa =
                new Map();

            for (
                const movimiento
                of pendientes
            ) {

                const clave =
                    normalizarTexto(
                        movimiento.taller
                    );

                if (
                    !mapa.has(
                        clave
                    )
                ) {

                    mapa.set(
                        clave,
                        {

                            taller:
                                movimiento.taller,

                            cantidad_movimientos:
                                0,

                            cantidad_abonable:
                                0,

                            cantidad_no_abonable:
                                0,

                            unidades_abonables:
                                0,

                            unidades_no_abonables:
                                0,

                            ultima_fecha:
                                movimiento.fecha,

                            ultima_hora:
                                movimiento.hora

                        }
                    );

                }

                const grupo =
                    mapa.get(
                        clave
                    );

                const cantidad =
                    numero(
                        movimiento.cantidad
                    );

                grupo.cantidad_movimientos++;

                if (
                    movimiento.abonable
                ) {

                    grupo.cantidad_abonable++;

                    grupo.unidades_abonables +=
                        cantidad;

                } else {

                    grupo.cantidad_no_abonable++;

                    grupo.unidades_no_abonables +=
                        cantidad;

                }

                grupo.ultima_fecha =
                    movimiento.fecha;

                grupo.ultima_hora =
                    movimiento.hora;

            }

            const talleres =
                Array.from(
                    mapa.values()
                )
                .filter(
                    taller =>
                        taller.cantidad_abonable >
                        0
                )
                .sort(
                    (a, b) =>
                        a.taller.localeCompare(
                            b.taller,
                            'es',
                            {
                                sensitivity:
                                    'base'
                            }
                        )
                );

            res.json({

                success:
                    true,

                talleres:
                    talleres

            });

        } catch (error) {

            console.error(
                '❌ ERROR PAGOS - TALLERES:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API PAGOS - DETALLE DE TALLER
// ============================================================

app.get(
    '/api/pagos/taller/:tallerNombre',
    async (
        req,
        res
    ) => {

        try {

            const nombre =
                texto(
                    req.params.tallerNombre
                );

            const movimientos =
                await obtenerMovimientosPagos();

            const pendientes =
                obtenerMovimientosPendientesPago(
                    movimientos
                );

            const detalle =
                pendientes.filter(
                    movimiento =>
                        normalizarTexto(
                            movimiento.taller
                        ) ===
                        normalizarTexto(
                            nombre
                        )
                );

            res.json({

                success:
                    true,

                taller:
                    nombre,

                movimientos:
                    detalle,

                resumen: {

                    cantidad_movimientos:
                        detalle.length,

                    cantidad_abonable:
                        detalle.filter(
                            x =>
                                x.abonable
                        ).length,

                    cantidad_no_abonable:
                        detalle.filter(
                            x =>
                                !x.abonable
                        ).length

                }

            });

        } catch (error) {

            console.error(
                '❌ ERROR PAGOS - DETALLE:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// COSTOS ACTUALES - RESPALDO PARA CONGELAR PAGOS
// ============================================================
// Si el navegador no entrega el precio calculado, el servidor lo
// recupera directamente de COSTOS en el mismo momento del pago.
// Esto evita guardar P/Q como 0 por una desincronización del navegador.
async function obtenerCostosActualesPago(){
    const filas = await obtenerHoja('COSTOS','A1:Z');
    if(!filas.length) return [];

    const encabezados = (filas[0] || []).map(v=>normalizarTexto(v));
    const idxTaller = encabezados.indexOf('TALLER');
    const idxArticulo = encabezados.indexOf('ARTICULO');
    const idxCosto = encabezados.indexOf('COSTO');
    const idxRemis = encabezados.indexOf('REMIS');

    if(idxTaller < 0) return [];

    return filas.slice(1).map(f=>({
        taller: texto(f[idxTaller]),
        articulo: idxArticulo >= 0 ? texto(f[idxArticulo]) : '',
        costo: idxCosto >= 0 ? numero(f[idxCosto]) : 0,
        remis: idxRemis >= 0 ? numero(f[idxRemis]) : 0
    })).filter(f=>f.taller);
}

function buscarCostoActualPago(filas,taller,articulo){
    const t=normalizarTexto(taller);
    const a=normalizarTexto(articulo);
    const especifico=filas.find(f=>normalizarTexto(f.taller)===t && normalizarTexto(f.articulo)===a);
    if(especifico) return especifico.costo;
    const general=filas.find(f=>normalizarTexto(f.taller)===t && !normalizarTexto(f.articulo));
    return general ? general.costo : 0;
}

function buscarRemisActualPago(filas,taller){
    const t=normalizarTexto(taller);
    const general=filas.find(f=>normalizarTexto(f.taller)===t && !normalizarTexto(f.articulo));
    return general ? general.remis : 0;
}

// ============================================================
// API PAGOS - REGISTRAR PAGO
// ============================================================

app.post(
    '/api/pagos/pagar',
    async (
        req,
        res
    ) => {

        try {

            const ids =
                Array.isArray(
                    req.body?.ids
                )
                    ? req.body.ids
                        .map(
                            id =>
                                texto(id)
                        )
                        .filter(Boolean)
                    : (
                        req.body?.id
                            ? [
                                texto(
                                    req.body.id
                                )
                            ]
                            : []
                    );

            if (
                !ids.length
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'No se recibieron movimientos para pagar.'

                });

            }

            /*
             * El navegador calcula la boleta ANTES de marcar los
             * movimientos como pagados. Recibimos esos importes
             * para congelarlos en BD en P/Q/R.
             */
            const boletasRecibidas =
                Array.isArray(req.body?.boletas)
                    ? req.body.boletas
                    : [];

            /*
             * Cada grupo recibido por pagos.html representa UNA BOLETA.
             * Guardamos el número de esa boleta por ID de movimiento.
             *
             * Esto es fundamental para BD:
             *   BOLETA 1 -> todos sus movimientos llevan N = 1
             *   BOLETA 2 -> todos sus movimientos llevan N = 2
             *   etc.
             *
             * También incluye S/ARMAR, MUESTRA y REPARACION aunque
             * tengan importe $0, porque siguen formando parte de la
             * boleta que el usuario armó.
             */
            const boletaPorId = new Map();
            const datosPorId = new Map();
            const remisPorFecha = new Map();

            boletasRecibidas.forEach((boleta, indiceBoleta) => {
                const items = Array.isArray(boleta?.items)
                    ? boleta.items
                    : [];

                const numeroBoletaPago =
                    String(indiceBoleta + 1);

                for (const item of items) {
                    const id = texto(item?.id);
                    if (!id) continue;

                    if (!boletaPorId.has(id)) {
                        boletaPorId.set(
                            id,
                            numeroBoletaPago
                        );
                    }

                    datosPorId.set(id, {
                        precioPago: numero(item?.costo),
                        importePago: numero(item?.importe)
                    });
                }

                // REMIS: una sola vez por FECHA, aunque haya varias
                // boletas para ese mismo día.
                const remis = numero(boleta?.remis);
                const fecha =
                    texto(items[0]?.fecha) ||
                    texto(boleta?.fecha);

                if (remis > 0 && fecha && !remisPorFecha.has(fecha)) {
                    remisPorFecha.set(fecha, remis);
                }
            });

            // Siempre dejamos un respaldo en servidor para que una
            // desincronización del navegador no congele NORMAL/REMIS en 0.
            const costosActualesPago =
                await obtenerCostosActualesPago();

            const movimientos =
                await obtenerMovimientosPagos();

            const seleccionados =
                movimientos.filter(
                    movimiento =>
                        ids.includes(
                            movimiento.id
                        )
                );

            if (
                !seleccionados.length
            ) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'No se encontraron los movimientos seleccionados.'

                });

            }

            // Si el navegador no envió el REMIS, recuperamos el valor
            // vigente del taller y lo congelamos igualmente. Es UNA vez
            // por fecha, nunca una vez por artículo.
            const fechasSeleccionadas = new Set(
                seleccionados
                    .filter(m => normalizarTexto(m.movimiento) === 'ENTRA')
                    .map(m => texto(m.fecha))
                    .filter(Boolean)
            );

            for (const fecha of fechasSeleccionadas) {
                if (!remisPorFecha.has(fecha)) {
                    const movimientoFecha = seleccionados.find(m => texto(m.fecha) === fecha);
                    const remisActual = movimientoFecha
                        ? buscarRemisActualPago(costosActualesPago, movimientoFecha.taller)
                        : 0;
                    if (remisActual > 0) {
                        remisPorFecha.set(fecha, remisActual);
                    }
                }
            }

            const actualizados = [];
            const fechasRemisAsignadas = new Set();

            for (
                const movimiento
                of seleccionados
            ) {

                const recibido =
                    datosPorId.get(movimiento.id) || {
                        precioPago: 0,
                        importePago: 0
                    };

                const tipoMovimientoPago = obtenerTipoPago(movimiento);
                const esEntradaPago = normalizarTexto(movimiento.movimiento) === 'ENTRA';

                let precioPago = numero(recibido.precioPago);
                let importePago = numero(recibido.importePago);

                // NORMAL: si P/Q llegaron en 0 o no llegaron, tomar el
                // precio ACTUAL del taller y congelarlo ahora.
                if(esEntradaPago && tipoMovimientoPago === 'NORMAL'){
                    if(precioPago <= 0){
                        precioPago = buscarCostoActualPago(
                            costosActualesPago,
                            movimiento.taller,
                            movimiento.articulo
                        );
                    }
                    if(importePago <= 0 && precioPago > 0){
                        importePago = numero(movimiento.cantidad) * precioPago;
                    }
                }else if(esEntradaPago){
                    // S/ARMAR, MUESTRA y REPARACIÓN son siempre $0.
                    precioPago = 0;
                    importePago = 0;
                }

                let remisPago = 0;

                // El REMIS se guarda una sola vez por fecha.
                // Preferimos colocarlo sobre un ENTRA de esa fecha;
                // si no existe ENTRA seleccionado, queda sobre la
                // primera fila seleccionada de la fecha.
                if (
                    remisPorFecha.has(movimiento.fecha) &&
                    !fechasRemisAsignadas.has(movimiento.fecha)
                ) {
                    const existeEntradaSeleccionada =
                        seleccionados.some(
                            otro =>
                                texto(otro.fecha) === texto(movimiento.fecha) &&
                                normalizarTexto(otro.movimiento) === 'ENTRA'
                        );

                    if (
                        normalizarTexto(movimiento.movimiento) === 'ENTRA' ||
                        !existeEntradaSeleccionada
                    ) {
                        remisPago = remisPorFecha.get(movimiento.fecha) || 0;
                        fechasRemisAsignadas.add(movimiento.fecha);
                    }
                }

                /*
                 * Si pagos.html envió las boletas, N contiene el número
                 * REAL de la boleta armada en pantalla.
                 *
                 * Para clientes/versiones anteriores que solo envíen
                 * IDs, conservamos la BOLETA que ya pudiera existir
                 * (por ejemplo, la asignada previamente a un REMIS).
                 */
                const boletaPago =
                    boletaPorId.get(movimiento.id) ||
                    movimiento.boleta ||
                    '';

                await actualizarFilaRango(
                    'BD',
                    movimiento.fila,
                    [
                        movimiento.id,
                        movimiento.fecha,
                        movimiento.taller,
                        movimiento.articulo,
                        String(movimiento.cantidad),
                        movimiento.color,
                        movimiento.movimiento,
                        movimiento.reparacion,
                        movimiento.sin_armar,
                        movimiento.muestra,
                        movimiento.hora,

                        // Todo ENTRA incluido en la boleta queda
                        // PAGADO=SI, sin importar si su importe es $0.
                        normalizarTexto(movimiento.movimiento) === 'ENTRA'
                            ? 'SI'
                            : (
                                normalizarTexto(movimiento.movimiento) === 'SALE' &&
                                texto(movimiento.boleta) !== ''
                                    ? 'SI'
                                    : 'NO'
                            ),

                        // Todo movimiento incluido en la liquidación
                        // queda FINALIZADO.
                        'SI',
                        boletaPago,
                        movimiento.id_articulo || '',
                        precioPago,
                        importePago,
                        remisPago
                    ]
                );

                actualizados.push({
                    ...movimiento,
                    pagado:
                        normalizarTexto(movimiento.movimiento) === 'ENTRA'
                            ? 'SI'
                            : (
                                normalizarTexto(movimiento.movimiento) === 'SALE' &&
                                texto(movimiento.boleta) !== ''
                                    ? 'SI'
                                    : 'NO'
                            ),
                    finalizado: 'SI',
                    boleta: boletaPago,
                    precio_pago: precioPago,
                    importe_pago: importePago,
                    remis_pago: remisPago
                });

            }


            // Actualizar inmediatamente el aviso del INDEX.
            // V1.23: no generar lecturas adicionales de Sheets para avisos.

            res.json({

                success:
                    true,

                movimientos:
                    actualizados,

                mensaje:
                    'Pago registrado correctamente.'

            });

        } catch (error) {

            console.error(
                '❌ ERROR /api/pagos/pagar:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API PAGOS - HISTORIAL
// ============================================================
//
// HISTORIAL = TODO lo que realmente quedó asentado dentro de una
// liquidación ya pagada/finalizada:
//
//   1) ENTRA pagado + finalizado.
//   2) SALE con BOLETA pagado + finalizado (REMIS).
//
// Una SALE con BOLETA representa el REMIS que formó parte de esa
// liquidación. Las SALE sin BOLETA no entran al historial porque son
// mercadería en tránsito y no forman parte del pago.
// ============================================================

app.get(
    '/api/pagos/historial',
    async (
        req,
        res
    ) => {

        try {

            const tallerFiltro =
                normalizarTexto(
                    req.query?.taller
                );

            const anioFiltro =
                texto(
                    req.query?.anio
                );

            const mesFiltro =
                texto(
                    req.query?.mes
                );

            const movimientos =
                await obtenerMovimientos();

            const historial =
                movimientos
                    .filter(
                        movimiento => {

                            const tipoMovimiento =
                                normalizarTexto(
                                    movimiento.movimiento
                                );

                            const esEntrada =
                                tipoMovimiento === 'ENTRA';

                            const esRemis =
                                tipoMovimiento === 'SALE' &&
                                texto(
                                    movimiento.boleta
                                ) !== '';

                            // ENTRA pagado/finalizado o SALE con BOLETA
                            // pagado/finalizado. Las SALE sin BOLETA son
                            // tránsito y no forman parte del historial.
                            if (
                                !esEntrada &&
                                !esRemis
                            ) {
                                return false;
                            }

                            if (
                                !esSi(
                                    movimiento.pagado
                                )
                            ) {
                                return false;
                            }

                            if (
                                !esSi(
                                    movimiento.finalizado
                                )
                            ) {
                                return false;
                            }

                            if (
                                !texto(
                                    movimiento.taller
                                )
                            ) {
                                return false;
                            }

                            if (
                                tallerFiltro &&
                                normalizarTexto(
                                    movimiento.taller
                                ) !== tallerFiltro
                            ) {
                                return false;
                            }

                            const partesFecha =
                                texto(
                                    movimiento.fecha
                                ).split('/');

                            if (
                                anioFiltro &&
                                (
                                    partesFecha.length !== 3 ||
                                    partesFecha[2] !== anioFiltro
                                )
                            ) {
                                return false;
                            }

                            if (
                                mesFiltro &&
                                mesFiltro !== 'TODOS'
                            ) {
                                if (
                                    partesFecha.length !== 3 ||
                                    String(Number(partesFecha[1])) !==
                                    String(Number(mesFiltro))
                                ) {
                                    return false;
                                }
                            }

                            return true;
                        }
                    )
                    .map(
                        movimiento => {

                            const esRemis =
                                normalizarTexto(
                                    movimiento.movimiento
                                ) === 'SALE' &&
                                texto(
                                    movimiento.boleta
                                ) !== '';

                            const tipo =
                                esRemis
                                    ? 'REMIS'
                                    : obtenerTipoPago(
                                        movimiento
                                    );

                            return {

                                id:
                                    movimiento.id,

                                fila:
                                    movimiento.fila,

                                fecha:
                                    movimiento.fecha,

                                hora:
                                    movimiento.hora,

                                taller:
                                    movimiento.taller,

                                articulo:
                                    movimiento.articulo,

                                cantidad:
                                    movimiento.cantidad,

                                color:
                                    movimiento.color,

                                movimiento:
                                    movimiento.movimiento,

                                reparacion:
                                    movimiento.reparacion,

                                sin_armar:
                                    movimiento.sin_armar,

                                muestra:
                                    movimiento.muestra,

                                pagado:
                                    movimiento.pagado,

                                finalizado:
                                    movimiento.finalizado,

                                // Valores congelados en BD (P/Q/R).
                                // Se conservan como texto para distinguir
                                // una celda realmente vacía de un 0.
                                precio_pago:
                                    movimiento.precio_pago ?? '',

                                importe_pago:
                                    movimiento.importe_pago ?? '',

                                remis_pago:
                                    movimiento.remis_pago ?? '',

                                // Necesario para que pagos.html agrupe
                                // correctamente todos los movimientos
                                // pertenecientes a una misma BOLETA.
                                boleta:
                                    movimiento.boleta || '',

                                tipo_pago:
                                    tipo,

                                abonable:
                                    esRemis
                                        ? true
                                        : tipo === 'NORMAL',

                                salida_aislada:
                                    esRemis,

                                orden:
                                    fechaHoraParaOrden(
                                        movimiento.fecha,
                                        movimiento.hora
                                    )
                            };
                        }
                    )
                    .sort(
                        (
                            a,
                            b
                        ) => {

                            if (
                                a.orden !==
                                b.orden
                            ) {
                                return b.orden - a.orden;
                            }

                            return Number(b.id) - Number(a.id);
                        }
                    );


            const talleres =
                Array.from(
                    new Set(
                        historial
                            .map(
                                item =>
                                    texto(
                                        item.taller
                                    )
                            )
                            .filter(Boolean)
                    )
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        a.localeCompare(
                            b,
                            'es',
                            {
                                sensitivity:
                                    'base'
                            }
                        )
                );

            console.log(
                '📜 HISTORIAL PAGOS:',
                historial.length,
                'movimientos'
            );

            console.log(
                '🏭 TALLERES HISTORIAL:',
                talleres
            );

            res.json({
                success: true,
                movimientos: historial,
                historial: historial,
                talleres: talleres
            });

        } catch (error) {

            console.error(
                '❌ ERROR HISTORIAL PAGOS:',
                error
            );

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);


// ============================================================
// API PAGOS - REABRIR
// ============================================================

app.post(
    '/api/pagos/reabrir',
    async (
        req,
        res
    ) => {

        try {

            const ids =
                Array.isArray(
                    req.body?.ids
                )
                    ? req.body.ids
                        .map(
                            id =>
                                texto(id)
                        )
                        .filter(Boolean)
                    : (
                        req.body?.id
                            ? [
                                texto(
                                    req.body.id
                                )
                            ]
                            : []
                    );

            if (
                !ids.length
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'No se recibieron movimientos para reabrir.'

                });

            }

            const movimientos =
                await obtenerMovimientos();

            const seleccionados =
                movimientos.filter(
                    movimiento =>
                        ids.includes(
                            movimiento.id
                        )
                );

            if (
                !seleccionados.length
            ) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'No se encontraron los movimientos seleccionados.'

                });

            }

            const actualizados =
                [];

            for (
                const movimiento
                of seleccionados
            ) {

                await actualizarFilaRango(
                    'BD',
                    movimiento.fila,
                    [
                        movimiento.id,
                        movimiento.fecha,
                        movimiento.taller,
                        movimiento.articulo,
                        String(movimiento.cantidad),
                        movimiento.color,
                        movimiento.movimiento,
                        movimiento.reparacion,
                        movimiento.sin_armar,
                        movimiento.muestra,
                        movimiento.hora,
                        'NO',
                        'NO',
                        movimiento.boleta || '',
                        movimiento.id_articulo || '',
                        '',
                        '',
                        ''
                    ]
                );

                actualizados.push({

                    ...movimiento,

                    pagado:
                        'NO',

                    finalizado:
                        'NO'

                });

            }

            res.json({

                success:
                    true,

                movimientos:
                    actualizados,

                mensaje:
                    'Pago reabierto correctamente.'

            });

        } catch (error) {

            console.error(
                '❌ ERROR /api/pagos/reabrir:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API REGISTRAR SALIDA
// ============================================================

app.post(
    '/api/talleres/:tallerId/salidas',
    async (
        req,
        res
    ) => {

        try {

            const taller =
                await obtenerTallerPorId(
                    req.params.tallerId
                );

            if (!taller) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'Taller no encontrado.'

                });

            }

            const articulo =
                texto(
                    req.body?.articulo
                );

            const cantidad =
                numero(
                    req.body?.cantidad
                );

            const color =
                texto(
                    req.body?.color
                );

            // Si el cliente no envía idArticuloTarea (por ejemplo,
            // una versión vieja de app.js), intentamos identificar la fila
            // exacta solamente cuando existe UNA coincidencia inequívoca.
            let idArticulo =
                texto(
                    req.body?.idArticuloTarea ||
                    req.body?.id_articulo ||
                    req.body?.idArticulo
                );

            if(!idArticulo){
                try{
                    const filasTA=await sheetsConReintento(
                        ()=>obtenerHoja('TAREAS_ARTICULOS','A2:H'),
                        'Búsqueda segura de TAREA_ARTICULO para SALE'
                    );

                    const candidatos=filasTA
                        .map((fila,i)=>({
                            fila,
                            filaReal:i+2,
                            id:texto(fila?.[0]),
                            articulo:texto(fila?.[2]),
                            taller:texto(fila?.[3]),
                            cantidad:numero(fila?.[4]),
                            color:texto(fila?.[5]).toUpperCase(),
                            fechaSalida:texto(fila?.[6]),
                            movimientoId:texto(fila?.[7])
                        }))
                        .filter(x=>
                            !x.fechaSalida &&
                            !x.movimientoId &&
                            normalizarTexto(x.articulo)===normalizarTexto(articulo) &&
                            numero(x.cantidad)===numero(cantidad) &&
                            normalizarTexto(x.color)===normalizarTexto(color) &&
                            (
                                !x.taller ||
                                normalizarTexto(x.taller)===normalizarTexto(taller.nombre)
                            )
                        );

                    if(candidatos.length===1){
                        idArticulo=candidatos[0].id;
                        console.log(
                            '🔎 ID_ARTICULO_TAREA inferido de forma inequívoca:',
                            idArticulo
                        );
                    }else if(candidatos.length>1){
                        console.warn(
                            '⚠️ SALE sin ID_ARTICULO_TAREA: hay múltiples coincidencias; no se adivina.',
                            {articulo,cantidad,color,taller:taller.nombre,candidatos:candidatos.length}
                        );
                    }
                }catch(errorInferencia){
                    console.error(
                        '⚠️ No se pudo inferir ID_ARTICULO_TAREA:',
                        errorInferencia.message
                    );
                }
            }

            const reparacion =
                normalizarTexto(
                    req.body?.reparacion
                ) ===
                'SI'
                    ? 'SI'
                    : 'NO';

            const sinArmar =
                normalizarTexto(
                    req.body?.sin_armar
                ) ===
                'SI'
                    ? 'SI'
                    : 'NO';

            const muestra =
                normalizarTexto(
                    color
                ) ===
                'MUESTRA'
                    ? 'SI'
                    : (
                        normalizarTexto(
                            req.body?.muestra
                        ) ===
                        'SI'
                            ? 'SI'
                            : 'NO'
                    );

            if (!articulo) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Artículo requerido.'

                });

            }

            if (
                cantidad <=
                0
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'La cantidad debe ser mayor a cero.'

                });

            }

            if (!color) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Color requerido.'

                });

            }

            // FECHA/HORA DE LA SALIDA:
            // siempre el momento real en Buenos Aires.
            // NO se usa fechaProduccion/fecha de la tarea.
            const ahoraArgentina =
                obtenerFechaHoraBuenosAires();

            const fecha =
                ahoraArgentina.fecha;

            const hora =
                ahoraArgentina.hora;

            // TAREAS_ARTICULOS guarda la fecha de salida en formato ISO
            // (YYYY-MM-DD), igual que las salidas ya existentes.
            // BD conserva su formato habitual DD/MM/YYYY en `fecha`.
            const fechaSalidaTarea =
                `${fecha.slice(6,10)}-${fecha.slice(3,5)}-${fecha.slice(0,2)}`;

            const id =
                await obtenerSiguienteID();

            await agregarFila(
                'BD',
                [

                    String(id),

                    fecha,

                    taller.nombre,

                    articulo,

                    String(
                        cantidad
                    ),

                    color,

                    'SALE',

                    reparacion,

                    sinArmar,

                    muestra,

                    hora,

                    'NO',

                    'NO',

                    '',

                    idArticulo

                ]
            );

            // =========================================================
            // VINCULAR LA SALIDA CON TAREAS_ARTICULOS
            //
            // Si AGREGAR salió de ARTÍCULOS DISPONIBLES, idArticulo es
            // el ID_ARTICULO_TAREA exacto. La fecha que se guarda aquí
            // es la FECHA REAL EN QUE EL TALLER SE LLEVA LA PRODUCCIÓN
            // (hoy), NO la fecha original de la tarea.
            //
            // A:F se conservan sin cambios. G=FECHA DE SALIDA y H=ID del movimiento SALE.
            // Nunca se escribe 'ENTREGADO' en G. De esta manera el artículo
            // desaparece automáticamente de /api/tareas/disponibles.
            // =========================================================
            if(idArticulo){
                const filasTA=await sheetsConReintento(
                    ()=>obtenerHoja('TAREAS_ARTICULOS','A2:H'),
                    'Búsqueda de ID_ARTICULO_TAREA para SALE'
                );

                const indiceTA=filasTA.findIndex(
                    fila=>texto(fila?.[0])===idArticulo
                );

                if(indiceTA<0){
                    throw new Error(
                        `No encontré ID_ARTICULO_TAREA ${idArticulo} en TAREAS_ARTICULOS.`
                    );
                }

                const filaTA=filasTA[indiceTA];
                const filaRealTA=indiceTA+2;

                const filaActualizada=[
                    texto(filaTA?.[0]),
                    texto(filaTA?.[1]),
                    texto(filaTA?.[2]),
                    texto(filaTA?.[3]).toUpperCase(),
                    texto(filaTA?.[4]),
                    texto(filaTA?.[5]).toUpperCase(),
                    fechaSalidaTarea,
                    String(id)
                ];

                await sheetsConReintento(
                    ()=>actualizarFilaRango(
                        'TAREAS_ARTICULOS',
                        filaRealTA,
                        filaActualizada
                    ),
                    'Vinculación de SALE con TAREAS_ARTICULOS'
                );

                console.log(
                    '🔗 SALE VINCULADA A TAREA_ARTICULO:',
                    {
                        idArticuloTarea:idArticulo,
                        fila:filaRealTA,
                        movimientoId:String(id),
                        fechaSalida:fechaSalidaTarea
                    }
                );
            }

            const movimientosActuales =
                await obtenerMovimientos();

            const horaSalidaSegundos =
                segundosHora(
                    hora
                );

            const ingresoAsociado =
                ingresoAsociadoRemis30Min(
                    {
                        id,
                        fecha,
                        hora,
                        taller: taller.nombre,
                        movimiento: 'SALE',
                        reparacion,
                        sin_armar: sinArmar,
                        muestra,
                        color,
                        boleta: ''
                    },
                    movimientosActuales
                );

            const salidaAislada =
                esSalidaRemisAisladaServidor(
                    {
                        id,
                        fecha,
                        hora,
                        taller: taller.nombre,
                        movimiento: 'SALE',
                        reparacion,
                        sin_armar: sinArmar,
                        muestra,
                        color,
                        boleta: ''
                    },
                    movimientosActuales
                );

            console.log(
                '🚚 DETECCIÓN REMIS:',
                {
                    taller:
                        taller.nombre,

                    fecha,

                    hora,

                    ingresoAsociado:
                        ingresoAsociado
                            ? {
                                id:
                                    ingresoAsociado.id,

                                hora:
                                    ingresoAsociado.hora
                            }
                            : null,

                    salidaAislada

                }
            );

            res.json({

                success:
                    true,

                id:
                    String(id),

                salidaAislada,

                ingresoAsociado:
                    ingresoAsociado
                        ? {
                            id:
                                ingresoAsociado.id,

                            hora:
                                ingresoAsociado.hora
                        }
                        : null,

                movimiento: {

                    id:
                        String(id),

                    fecha,

                    taller:
                        taller.nombre,

                    articulo,

                    cantidad,

                    color,

                    movimiento:
                        'SALE',

                    reparacion,

                    sin_armar:
                        sinArmar,

                    muestra,

                    hora,

                    pagado:
                        'NO',

                    finalizado:
                        'NO',

                    boleta:
                        '',

                    id_articulo:
                        idArticulo

                }

            });

        } catch (error) {

            console.error(
                '❌ ERROR REGISTRANDO SALE:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);// ============================================================
// API REGISTRAR ENTRADA
// ============================================================

app.post(
    '/api/talleres/:tallerId/entradas',
    async (
        req,
        res
    ) => {

        try {

            const taller =
                await obtenerTallerPorId(
                    req.params.tallerId
                );

            if (!taller) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'Taller no encontrado.'

                });

            }

            const articulo =
                texto(
                    req.body?.articulo
                );

            const cantidad =
                numero(
                    req.body?.cantidad
                );

            const color =
                texto(
                    req.body?.color
                );

            const idArticulo =
                texto(
                    req.body?.idArticuloTarea ||
                    req.body?.id_articulo ||
                    req.body?.idArticulo
                );

            const reparacion =
                normalizarTexto(
                    req.body?.reparacion
                ) ===
                'SI'
                    ? 'SI'
                    : 'NO';

            const sinArmar =
                normalizarTexto(
                    req.body?.sin_armar
                ) ===
                'SI'
                    ? 'SI'
                    : 'NO';

            const muestra =
                normalizarTexto(
                    color
                ) ===
                'MUESTRA'
                    ? 'SI'
                    : (
                        normalizarTexto(
                            req.body?.muestra
                        ) ===
                        'SI'
                            ? 'SI'
                            : 'NO'
                    );

            if (!articulo) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Artículo requerido.'

                });

            }

            if (
                cantidad <=
                0
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'La cantidad debe ser mayor a cero.'

                });

            }

            if (!color) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Color requerido.'

                });

            }

            // FECHA/HORA DE LA ENTRADA: siempre hora real de Argentina.
            // No usar new Date().getHours(), porque el servidor puede estar en UTC.
            const ahoraArgentina =
                obtenerFechaHoraBuenosAires();

            const fecha =
                ahoraArgentina.fecha;

            const hora =
                ahoraArgentina.hora;

            const id =
                await obtenerSiguienteID();

            await agregarFila(
                'BD',
                [

                    String(id),

                    fecha,

                    taller.nombre,

                    articulo,

                    String(
                        cantidad
                    ),

                    color,

                    'ENTRA',

                    reparacion,

                    sinArmar,

                    muestra,

                    hora,

                    'NO',

                    'NO',

                    '',

                    idArticulo

                ]
            );

            res.json({

                success:
                    true,

                id:
                    String(id),

                movimiento: {

                    id:
                        String(id),

                    fecha,

                    taller:
                        taller.nombre,

                    articulo,

                    cantidad,

                    color,

                    movimiento:
                        'ENTRA',

                    reparacion,

                    sin_armar:
                        sinArmar,

                    muestra,

                    hora,

                    pagado:
                        'NO',

                    finalizado:
                        'NO',

                    boleta:
                        '',

                    id_articulo:
                        idArticulo

                }

            });

        } catch (error) {

            console.error(
                '❌ ERROR REGISTRANDO ENTRADA:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// API — LOGIN GENERAL
// ============================================================



// ============================================================
// CONTROL DE ROLLOS — GOOGLE SHEETS
// Permiso ROLLOS exigido por authMejorada en /api/rollos/*
// ============================================================
const gcRollosLock = {cola:Promise.resolve()};
function gcRollosEnCola(trabajo){
    const pendiente=gcRollosLock.cola.then(trabajo,trabajo);
    gcRollosLock.cola=pendiente.catch(()=>{});
    return pendiente;
}
function gcNumero(valor){
    const n=Number(String(valor??'').replace(',','.'));
    return Number.isFinite(n)?n:NaN;
}
async function gcLeerRollos(){
    const filas=await obtenerHoja('ROLLOS','A2:F');
    return filas.map((r,i)=>({
        fila:i+2,material:texto(r?.[0]).trim(),color:texto(r?.[1]).trim(),
        mtsRollo:gcNumero(r?.[2]),rollos:gcNumero(r?.[3])
    })).filter(r=>r.material&&r.color);
}
app.get('/api/rollos',async(req,res)=>{
    try{
        const rollos=await gcLeerRollos();
        res.json({success:true,rollos});
    }catch(e){console.error('ROLLOS GET',e);res.status(500).json({success:false,error:e.message});}
});
app.post('/api/rollos/mover',async(req,res)=>{
    try{
        const resultado=await gcRollosEnCola(async()=>{
            const fila=Number(req.body?.fila), cantidad=Number(req.body?.cantidad);
            const tipo=req.body?.tipo;
            if(!Number.isSafeInteger(fila)||fila<2||!Number.isSafeInteger(cantidad)||cantidad<1||!['sumar','descontar'].includes(tipo)){
                const err=new Error('Datos de movimiento inválidos.');err.status=400;throw err;
            }
            const todos=await gcLeerRollos();
            const actual=todos.find(x=>x.fila===fila);
            if(!actual||actual.material!==texto(req.body?.material).trim()||actual.color!==texto(req.body?.color).trim()){
                const err=new Error('El material cambió. Actualizá la página.');err.status=409;throw err;
            }
            if(!Number.isFinite(actual.mtsRollo)||actual.mtsRollo<=0||!Number.isSafeInteger(actual.rollos)||actual.rollos<0){
                const err=new Error('Los datos del rollo en Sheets no son válidos.');err.status=400;throw err;
            }
            const nuevo=actual.rollos+(tipo==='sumar'?cantidad:-cantidad);
            if(nuevo<0){const err=new Error('No hay suficientes rollos.');err.status=400;throw err;}
            // Al descontar el último rollo se elimina la fila completa de ROLLOS.
            // La cola gcRollosEnCola impide que otro movimiento de este servidor
            // use una numeración de filas desactualizada durante la eliminación.
            if(nuevo===0){
                await borrarFila('ROLLOS',fila);
                return {fila,rollos:0,eliminado:true};
            }
            const fecha=obtenerFechaHoraBuenosAires().fecha;
            await sheets.spreadsheets.values.update({spreadsheetId:GOOGLE_SHEET_ID,range:`ROLLOS!D${fila}:F${fila}`,valueInputOption:'USER_ENTERED',requestBody:{values:[[nuevo,Math.round(nuevo*actual.mtsRollo*100)/100,fecha]]}});
            return {fila,rollos:nuevo,eliminado:false};
        });
        res.json({success:true,...resultado});
    }catch(e){console.error('ROLLOS MOVER',e);res.status(e.status||500).json({success:false,error:e.message});}
});
app.post('/api/rollos/nuevo',async(req,res)=>{
    try{
        await gcRollosEnCola(async()=>{
            const material=texto(req.body?.material).trim().toUpperCase();
            const color=texto(req.body?.color).trim().toUpperCase();
            const mtsRollo=gcNumero(req.body?.mtsRollo),cantidad=Number(req.body?.cantidad);
            if(!material||!color||material.length>100||color.length>100||!Number.isFinite(mtsRollo)||mtsRollo<=0||!Number.isSafeInteger(cantidad)||cantidad<0){
                const err=new Error('Datos de material inválidos.');err.status=400;throw err;
            }
            const todos=await gcLeerRollos();
            if(todos.some(x=>x.material.toUpperCase()===material&&x.color.toUpperCase()===color)){
                const err=new Error('Ese material y color ya existe.');err.status=409;throw err;
            }
            await agregarFila('ROLLOS',[material,color,mtsRollo,cantidad,Math.round(mtsRollo*cantidad*100)/100,obtenerFechaHoraBuenosAires().fecha]);
        });
        res.json({success:true});
    }catch(e){console.error('ROLLOS NUEVO',e);res.status(e.status||500).json({success:false,error:e.message});}
});

// ============================================================
// API — ADMINISTRACIÓN DE USUARIOS (SOLO SUPERADMIN)
// ============================================================

async function exigirSuperadmin(req,res){
    const usuario = req.usuarioGC || await usuarioDesdeRequest(req);

    if(!usuario || normalizarTexto(usuario.ROL)!=='SUPERADMIN'){
        res.status(403).json({
            success:false,
            error:'Solo el SUPERADMIN puede administrar usuarios.'
        });
        return null;
    }

    return usuario;
}

app.get('/api/admin/usuarios',async(req,res)=>{
    try{
        if(!await exigirSuperadmin(req,res)) return;

        const usuarios=await obtenerUsuarios();

        res.json({
            success:true,
            usuarios:usuarios.map(u=>({
                fila:u.fila,
                usuario:u.USUARIO,
                nombre:u.NOMBRE,
                activo:u.ACTIVO,
                rol:u.ROL,
                permisos:{
                    INGRESOS_EGRESOS:esSi(u.INGRESOS_EGRESOS),
                    TAREAS:esSi(u.TAREAS),
                    PRODUCCION:esSi(u.PRODUCCION),
                    TALLERES:esSi(u.TALLERES),
                    PAGOS:esSi(u.PAGOS),
                    BD:esSi(u.BD),
                    ROLLOS:esSi(u.ROLLOS),
                    STOCK_ONLINE:usuarioTienePermiso(u,'STOCK_ONLINE')
                },
                tienePassword:Boolean(u.PASSWORD_HASH)
            }))
        });

    }catch(error){
        console.error('❌ ERROR LISTANDO USUARIOS:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.post('/api/admin/usuarios',async(req,res)=>{
    try{
        const admin=await exigirSuperadmin(req,res);
        if(!admin) return;

        const usuario=texto(req.body?.usuario).toUpperCase();
        const nombre=texto(req.body?.nombre);
        const password=texto(req.body?.password);
        const rol=(texto(req.body?.rol)||'USUARIO').toUpperCase();
        const activo=req.body?.activo===false?'NO':'SI';
        const permisos=req.body?.permisos||{};

        if(!/^[A-Z0-9_.-]{2,30}$/.test(usuario)){
            return res.status(400).json({
                success:false,
                error:'El usuario debe tener entre 2 y 30 caracteres y usar letras, números, punto, guion o guion bajo.'
            });
        }

        if(!password || password.length<6){
            return res.status(400).json({
                success:false,
                error:'La contraseña debe tener al menos 6 caracteres.'
            });
        }

        if(await obtenerUsuarioPorNombre(usuario)){
            return res.status(409).json({
                success:false,
                error:'Ese usuario ya existe.'
            });
        }

        if(rol==='SUPERADMIN'){
            return res.status(400).json({
                success:false,
                error:'El SUPERADMIN principal se administra desde SERPER.'
            });
        }

        await agregarFila('USUARIOS',[
            usuario,
            nombre,
            hashPassword(password),
            activo,
            rol,
            esSi(permisos.INGRESOS_EGRESOS)?'SI':'NO',
            esSi(permisos.TAREAS)?'SI':'NO',
            esSi(permisos.PRODUCCION)?'SI':'NO',
            esSi(permisos.TALLERES)?'SI':'NO',
            esSi(permisos.PAGOS)?'SI':'NO',
            esSi(permisos.BD)?'SI':'NO',
            esSi(permisos.ROLLOS)?'SI':'NO',
            esSi(permisos.STOCK_ONLINE)?'SI':'NO'
        ]);

        res.json({success:true});

    }catch(error){
        console.error('❌ ERROR CREANDO USUARIO:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.put('/api/admin/usuarios/:usuario',async(req,res)=>{
    try{
        const admin=await exigirSuperadmin(req,res);
        if(!admin) return;

        const buscado=decodeURIComponent(req.params.usuario).toUpperCase();
        const existente=await obtenerUsuarioPorNombre(buscado);

        if(!existente){
            return res.status(404).json({success:false,error:'Usuario no encontrado.'});
        }

        if(existente.ROL==='SUPERADMIN' && buscado==='SERPER'){
            // Permitimos cambiar nombre, estado y permisos de SERPER,
            // pero nunca quitarle el rol SUPERADMIN ni eliminarlo.
            existente.NOMBRE=texto(req.body?.nombre)||existente.NOMBRE;
            existente.ACTIVO=req.body?.activo===false?'NO':'SI';
            existente.ROL='SUPERADMIN';
        }else{
            existente.NOMBRE=texto(req.body?.nombre);
            existente.ACTIVO=req.body?.activo===false?'NO':'SI';
            existente.ROL=(texto(req.body?.rol)||'USUARIO').toUpperCase();
            if(existente.ROL==='SUPERADMIN') existente.ROL='USUARIO';
        }

        const permisos=req.body?.permisos||{};
        const nuevoPassword=texto(req.body?.password);

        if(nuevoPassword){
            if(nuevoPassword.length<6){
                return res.status(400).json({
                    success:false,
                    error:'La contraseña debe tener al menos 6 caracteres.'
                });
            }
            existente.PASSWORD_HASH=hashPassword(nuevoPassword);
        }

        await actualizarFilaRango(
            'USUARIOS',
            existente.fila,
            [
                existente.USUARIO,
                existente.NOMBRE,
                existente.PASSWORD_HASH,
                existente.ACTIVO,
                existente.ROL,
                esSi(permisos.INGRESOS_EGRESOS)?'SI':'NO',
                esSi(permisos.TAREAS)?'SI':'NO',
                esSi(permisos.PRODUCCION)?'SI':'NO',
                esSi(permisos.TALLERES)?'SI':'NO',
                esSi(permisos.PAGOS)?'SI':'NO',
                esSi(permisos.BD)?'SI':'NO',
            esSi(permisos.ROLLOS)?'SI':'NO',
            esSi(permisos.STOCK_ONLINE)?'SI':'NO'
            ]
        );

        res.json({success:true});

    }catch(error){
        console.error('❌ ERROR EDITANDO USUARIO:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.delete('/api/admin/usuarios/:usuario',async(req,res)=>{
    try{
        const admin=await exigirSuperadmin(req,res);
        if(!admin) return;

        const buscado=decodeURIComponent(req.params.usuario).toUpperCase();
        if(buscado==='SERPER'){
            return res.status(400).json({
                success:false,
                error:'El SUPERADMIN principal no se puede eliminar.'
            });
        }

        const usuario=await obtenerUsuarioPorNombre(buscado);

        if(!usuario){
            return res.status(404).json({success:false,error:'Usuario no encontrado.'});
        }

        await borrarFila('USUARIOS',usuario.fila);

        res.json({success:true});

    }catch(error){
        console.error('❌ ERROR ELIMINANDO USUARIO:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.get('/api/auth/me',async(req,res)=>{
    try{
        const usuario=await usuarioDesdeRequest(req);

        if(!usuario){
            return res.status(401).json({
                success:false,
                autenticado:false
            });
        }

        res.json({
            success:true,
            autenticado:true,
            usuario:{
                usuario:usuario.USUARIO,
                nombre:usuario.NOMBRE,
                rol:usuario.ROL,
                permisos:{
                    INGRESOS_EGRESOS:usuarioTienePermiso(usuario,'INGRESOS_EGRESOS'),
                    TAREAS:usuarioTienePermiso(usuario,'TAREAS'),
                    PRODUCCION:usuarioTienePermiso(usuario,'PRODUCCION'),
                    TALLERES:usuarioTienePermiso(usuario,'TALLERES'),
                    PAGOS:usuarioTienePermiso(usuario,'PAGOS'),
                    BD:usuarioTienePermiso(usuario,'BD'),
                    ROLLOS:usuarioTienePermiso(usuario,'ROLLOS'),
                    STOCK_ONLINE:usuarioTienePermiso(usuario,'STOCK_ONLINE')
                }
            }
        });

    }catch(error){
        console.error('❌ ERROR /api/auth/me:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.post('/api/auth/login',async(req,res)=>{
    try{
        const usuarioNombre=texto(req.body?.usuario).toUpperCase();
        const password=texto(req.body?.password);
        const recordar=Boolean(req.body?.recordar);

        if(!usuarioNombre || !password){
            return res.status(400).json({
                success:false,
                error:'Completá usuario y contraseña.'
            });
        }

        const usuario=await obtenerUsuarioPorNombre(usuarioNombre);

        if(!usuario || !esSi(usuario.ACTIVO)){
            return res.status(401).json({
                success:false,
                error:'Usuario o contraseña incorrectos.'
            });
        }

        if(!usuario.PASSWORD_HASH){
            // Solo SERPER (SUPERADMIN) puede configurar su clave inicial
            // desde la pantalla de acceso. Los demás usuarios son
            // configurados por el SUPERADMIN desde ADMINISTRAR USUARIOS.
            if(
                normalizarTexto(usuario.ROL)==='SUPERADMIN' &&
                usuario.USUARIO==='SERPER'
            ){
                return res.status(409).json({
                    success:false,
                    configurar:true,
                    error:'El SUPERADMIN todavía no tiene contraseña configurada.'
                });
            }

            return res.status(401).json({
                success:false,
                error:'Esta cuenta todavía no tiene contraseña. El SUPERADMIN debe configurarla desde ADMINISTRAR USUARIOS.'
            });
        }

        if(!comprobarPassword(password,usuario.PASSWORD_HASH)){
            return res.status(401).json({
                success:false,
                error:'Usuario o contraseña incorrectos.'
            });
        }

        const tokenNuevo = crearTokenAuth(
            usuario.USUARIO,
            usuario.PASSWORD_HASH,
            recordar
        );

        const tokenValidado = leerTokenAuth({
            headers:{
                cookie:`${AUTH_COOKIE}=${encodeURIComponent(tokenNuevo)}`
            }
        });

        if(tokenValidado){
            sesionesGC.set(claveSesionGC(tokenValidado), {
                usuario,
                expira: tokenValidado.expira
            });
        }

        cookieAuth(res, tokenNuevo, recordar);

        res.json({
            success:true,
            usuario:{
                usuario:usuario.USUARIO,
                nombre:usuario.NOMBRE,
                rol:usuario.ROL
            }
        });

    }catch(error){
        console.error('❌ ERROR LOGIN GENERAL:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.post('/api/auth/setup',async(req,res)=>{
    try{
        const usuarioNombre=texto(req.body?.usuario).toUpperCase();
        const password=texto(req.body?.password);
        const recordar=req.body?.recordar !== false;

        if(!usuarioNombre || password.length<6){
            return res.status(400).json({
                success:false,
                error:'La contraseña debe tener al menos 6 caracteres.'
            });
        }

        const usuario=await obtenerUsuarioPorNombre(usuarioNombre);

        if(!usuario){
            return res.status(404).json({
                success:false,
                error:'No existe ese usuario en la hoja USUARIOS.'
            });
        }

        if(usuario.PASSWORD_HASH){
            return res.status(409).json({
                success:false,
                error:'Ese usuario ya tiene contraseña configurada.'
            });
        }

        if(
            normalizarTexto(usuario.ROL)!=='SUPERADMIN' ||
            !esSi(usuario.ACTIVO)
        ){
            return res.status(403).json({
                success:false,
                error:'Solo se puede configurar inicialmente un SUPERADMIN activo.'
            });
        }

        const nuevoHash=hashPassword(password);

        await actualizarFilaRango(
            'USUARIOS',
            usuario.fila,
            [
                usuario.USUARIO,
                usuario.NOMBRE,
                nuevoHash,
                usuario.ACTIVO,
                usuario.ROL,
                usuario.INGRESOS_EGRESOS,
                usuario.TAREAS,
                usuario.PRODUCCION,
                usuario.TALLERES,
                usuario.PAGOS,
                usuario.BD,
                usuario.ROLLOS
            ]
        );

        cookieAuth(
            res,
            crearTokenAuth(usuario.USUARIO,nuevoHash,recordar),
            recordar
        );

        res.json({
            success:true,
            configurado:true,
            usuario:{
                usuario:usuario.USUARIO,
                nombre:usuario.NOMBRE,
                rol:usuario.ROL
            }
        });

    }catch(error){
        console.error('❌ ERROR CONFIGURANDO SUPERADMIN:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.post('/api/auth/logout',(req,res)=>{
    const token = leerTokenAuth(req);
    if(token) sesionesGC.delete(claveSesionGC(token));
    limpiarAuth(res);
    res.json({success:true});
});

// ============================================================
// OBTENER BD
// ============================================================

app.get(
    '/api/bd',
    async (
        req,
        res
    ) => {

        try {
const movimientos =
                await obtenerMovimientos();

            res.json({

                success:
                    true,

                movimientos:
                    movimientos

            });

        } catch (error) {

            console.error(
                '❌ ERROR CARGANDO BD:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);

// ============================================================
// EDITAR BD
// ============================================================

app.put(
    '/api/bd/:id',
    async (
        req,
        res
    ) => {

        try {
const id =
                texto(
                    req.params.id
                );

            const movimientos =
                await obtenerMovimientos();

            const movimiento =
                movimientos.find(
                    item =>
                        item.id ===
                        id
                );

            if (!movimiento) {

                return res.status(404).json({

                    success:
                        false,

                    error:
                        'Movimiento no encontrado.'

                });

            }

            const fecha =
                req.body?.fecha !== undefined
                    ? texto(
                        req.body.fecha
                    )
                    : movimiento.fecha;

            const taller =
                req.body?.taller !== undefined
                    ? texto(
                        req.body.taller
                    )
                    : movimiento.taller;

            const articulo =
                req.body?.articulo !== undefined
                    ? texto(
                        req.body.articulo
                    )
                    : movimiento.articulo;

            const cantidad =
                req.body?.cantidad !== undefined
                    ? numero(
                        req.body.cantidad
                    )
                    : movimiento.cantidad;

            const color =
                req.body?.color !== undefined
                    ? texto(
                        req.body.color
                    )
                    : movimiento.color;

            const movimientoTipo =
                req.body?.movimiento !== undefined
                    ? texto(
                        req.body.movimiento
                    )
                    : movimiento.movimiento;

            const reparacion =
                req.body?.reparacion !== undefined
                    ? texto(
                        req.body.reparacion
                    )
                    : movimiento.reparacion;

            const sinArmar =
                req.body?.sin_armar !== undefined
                    ? texto(
                        req.body.sin_armar
                    )
                    : movimiento.sin_armar;

            const muestra =
                req.body?.muestra !== undefined
                    ? texto(
                        req.body.muestra
                    )
                    : movimiento.muestra;

            const pagado =
                movimiento.pagado;

            const finalizado =
                movimiento.finalizado;

            const hora =
                movimiento.hora;

            await actualizarFila(
                'BD',
                movimiento.fila,
                [

                    movimiento.id,

                    fecha,

                    taller,

                    articulo,

                    String(
                        cantidad
                    ),

                    color,

                    movimientoTipo,

                    reparacion,

                    sinArmar,

                    muestra,

                    hora,

                    pagado,

                    finalizado,

                    movimiento.boleta ||
                        '',

                    movimiento.id_articulo ||
                        ''

                ]
            );

            res.json({

                success:
                    true,

                movimiento: {

                    id:
                        movimiento.id,

                    fecha,

                    taller,

                    articulo,

                    cantidad,

                    color,

                    movimiento:
                        movimientoTipo,

                    reparacion,

                    sin_armar:
                        sinArmar,

                    muestra,

                    hora,

                    pagado,

                    finalizado,

                    boleta:
                        movimiento.boleta ||
                        '',

                    id_articulo:
                        movimiento.id_articulo ||
                        ''

                }

            });

        } catch (error) {

            console.error(
                '❌ ERROR EDITANDO BD:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// API TAREAS — GOOGLE SHEETS
// ============================================================

// IMPORTANTE:
// Para TAREAS usamos batchGet/batchUpdate. Cada batch cuenta como UNA
// solicitud de API, aunque contenga varias hojas/rangos. Esto evita
// consumir la cuota leyendo/escribiendo una hoja por vez.

function esperar(ms){
    return new Promise(resolve=>setTimeout(resolve,ms));
}

async function sheetsConReintento(fn, etiqueta='Google Sheets'){
    let espera=1000;
    for(let intento=0;intento<5;intento++){
        try{
            return await fn();
        }catch(error){
            const mensaje=String(error?.message||error||'');
            const codigo=error?.code||error?.response?.status;
            const esCuota=codigo===429 || /quota exceeded|too many requests|rate limit/i.test(mensaje);
            if(!esCuota || intento===4) throw error;
            console.warn(`⚠️ ${etiqueta}: cuota alcanzada. Reintento en ${espera} ms...`);
            await esperar(espera);
            espera=Math.min(60000,espera*2);
        }
    }
}

function normalizarTareaDesdeSheet(fila, filaReal) {
    return {
        id:normalizarIdTarea(fila?.[0]),
        fila:filaReal,
        fecha:texto(fila?.[1]),
        cantidad:numero(fila?.[2]),
        color:texto(fila?.[3]),
        estado:normalizarTexto(fila?.[4])==='COMPLETO' ? 'COMPLETO' : 'PENDIENTE',
        colores:[],
        articulos:[]
    };
}

function ultimaFilaConDatos(filas, filaInicial=2){
    // values.batchGet devuelve también huecos intermedios cuando existen.
    // Para agregar registros NO usamos filas.length, porque eso perpetúa
    // huecos enormes. Buscamos la última fila que realmente tenga algún dato.
    for(let i=filas.length-1;i>=0;i--){
        const fila=Array.isArray(filas[i])?filas[i]:[];
        if(fila.some(v=>String(v??'').trim()!=='')){
            return filaInicial+i;
        }
    }
    return filaInicial-1;
}

// IDs de producción: AAAAMMDD. El ID_TAREA es directamente la fecha.
function baseIdTareaPorFecha(fecha){
    const m=String(fecha||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return '';
    return `${m[1]}${m[2]}${m[3]}`;
}

function generarIdTareaPorFecha(fecha){
    // Compatibilidad con código antiguo.
    // El ID_TAREA ya NO lleva sufijo: es directamente AAAAMMDD.
    const base=baseIdTareaPorFecha(fecha);
    if(!base) throw new Error('La fecha de la tarea no es válida.');
    return base;
}

function normalizarIdTarea(valor){
    let s=texto(valor);
    if(!s) return '';
    s=s.replace(/-\d{2}$/,'');

    // ========================================================
    // ID_TAREA DEFINITIVO: AAAAMMDD
    //
    // Ejemplo:
    // 08/01/2026 -> 20260108
    //
    // Google Sheets puede quitar el cero inicial de un ID viejo
    // DDMMAAAA. Ese caso se normaliza solamente para poder leer
    // datos antiguos; NUNCA se genera un ID nuevo en DDMMAAAA.
    // ========================================================

    if(/^\d{7}$/.test(s)){
        // Ej.: 8012026 -> 08012026 (viejo DDMMAAAA)
        s='0'+s;
    }

    if(/^\d{8}$/.test(s)){
        const dia=Number(s.slice(0,2));
        const mes=Number(s.slice(2,4));
        const anio=Number(s.slice(4,8));

        // Si tiene forma válida DDMMAAAA, convertir a AAAAMMDD.
        // Si ya es AAAAMMDD (ej. 20260108), NO tocarlo.
        if(dia>=1 && dia<=31 && mes>=1 && mes<=12 && anio>=2000){
            s=`${anio}${String(mes).padStart(2,'0')}${String(dia).padStart(2,'0')}`;
        }
    }

    return s;
}

function normalizarArticuloParaId(valor){
    return texto(valor).replace(/\s+/g,'');
}

function generarIdArticuloPorArticulo(idTarea, articulo, idsOcupados=new Set()){
    const base=normalizarArticuloParaId(articulo);
    if(!base) throw new Error('Artículo inválido para generar ID_ARTICULO_TAREA.');
    let n=1;
    while(idsOcupados.has(`${idTarea}-${base}-${n}`)) n++;
    return `${idTarea}-${base}-${n}`;
}

async function obtenerDatosTareasEnBloque(){
    if(!sheets) throw new Error('Google Sheets no está conectado.');

    const respuesta=await sheetsConReintento(
        ()=>sheets.spreadsheets.values.batchGet({
            spreadsheetId:GOOGLE_SHEET_ID,
            ranges:[
                'TAREAS!A2:E',
                'TAREAS_ARTICULOS!A2:H',
                'TAREAS_COLORES!A2:C'
            ]
        }),
        'Lectura de TAREAS'
    );

    const valores=respuesta.data.valueRanges||[];
    return {
        tareas:valores[0]?.values||[],
        articulos:valores[1]?.values||[],
        colores:valores[2]?.values||[]
    };
}

async function obtenerTareasCentralizadas() {
    const datos=await obtenerDatosTareasEnBloque();
    const filasTareas=datos.tareas;
    const filasArticulos=datos.articulos;
    const filasColores=datos.colores;

    const mapa=new Map();

    filasTareas.forEach((fila,i)=>{
        const id=normalizarIdTarea(fila?.[0]);
        // 'sync' fue una marca de prueba de una versión anterior.
        if(!id || id.toLowerCase()==='sync')return;
        mapa.set(id,normalizarTareaDesdeSheet(fila,i+2));
    });

    filasColores.forEach((fila,i)=>{
        // Igual que en TAREAS_ARTICULOS, Google Sheets puede haber
        // quitado el cero inicial del ID de la tarea.
        const id=normalizarIdTarea(fila?.[0]);
        if(!id||!mapa.has(id))return;
        mapa.get(id).colores.push({
            id:`TC-${i+2}`,
            fila:i+2,
            color:texto(fila?.[1]).toUpperCase(),
            cantidad:numero(fila?.[2])
        });
    });

    filasArticulos.forEach((fila,i)=>{
        // Google Sheets puede quitar el cero inicial de fechas usadas como ID.
        // Ej.: 02032026 puede llegar como 2032026.
        // Siempre normalizamos el ID antes de buscar la tarea.
        const idTarea=normalizarIdTarea(fila?.[1]);
        if(!idTarea||!mapa.has(idTarea))return;
        const fechaSalida=texto(fila?.[6]);
        const taller=texto(fila?.[3]);
        const estado=fechaSalida
            ? 'ENTREGADO'
            : (taller ? 'RESERVADO' : 'SIN TALLER');

        mapa.get(idTarea).articulos.push({
            id:texto(fila?.[0]),
            fila:i+2,
            articulo:texto(fila?.[2]),
            taller,
            cantidad:numero(fila?.[4]),
            color:texto(fila?.[5]).toUpperCase(),
            estado,
            fechaSalida,
            movimientoId:texto(fila?.[7])
        });
    });

    return [...mapa.values()];
}

function tareaParaCliente(tarea) {
    return {
        id:tarea.id,
        fecha:tarea.fecha,
        cantidad:tarea.cantidad,
        color:tarea.color,
        colores:(tarea.colores||[]).map(x=>({
            color:x.color,cantidad:x.cantidad
        })),
        articulos:(tarea.articulos||[]).map(x=>({
            id:x.id,
            articulo:x.articulo,
            taller:x.taller,
            cantidad:x.cantidad||tarea.cantidad||0,
            color:texto(x.color).toUpperCase() || texto(tarea.color).toUpperCase(),
            estado:normalizarTexto(x.estado) || 'SIN TALLER',
            fechaSalida:x.fechaSalida||'',
            movimientoId:x.movimientoId||''
        })),
        estado:normalizarTexto(tarea.estado)==='COMPLETO' ? 'COMPLETO' : 'PENDIENTE'
    };
}

async function eliminarFilasPorIndices(nombreHoja,filas) {
    const unicas=[...new Set(
        filas.map(Number).filter(n=>Number.isInteger(n)&&n>=2)
    )].sort((a,b)=>b-a);
    for(const fila of unicas) await borrarFila(nombreHoja,fila);
}


// ============================================================
// CURSORES EN MEMORIA PARA LAS HOJAS DE TAREAS
// ============================================================
// Se hace UNA lectura de la columna A al iniciar el servidor.
// Después, las nuevas tareas escriben directamente en la siguiente
// fila conocida. Esto evita volver a leer miles de filas en cada alta.
// Si el proceso reinicia, se reconstruye una sola vez.
const cursorSheets = {
    tareas: 1,
    tareasArticulos: 1,
    tareasColores: 1,
    lista: false,
    inicializando: null
};

async function inicializarCursoresSheets() {
    if (cursorSheets.lista) return;
    if (cursorSheets.inicializando) return cursorSheets.inicializando;

    cursorSheets.inicializando = (async()=>{
        try {
            const r = await sheetsConReintento(
                ()=>sheets.spreadsheets.values.batchGet({
                    spreadsheetId: GOOGLE_SHEET_ID,
                    ranges:[
                        'TAREAS!A:A',
                        'TAREAS_ARTICULOS!A:A',
                        'TAREAS_COLORES!A:A'
                    ],
                    majorDimension:'COLUMNS'
                }),
                'Inicialización de cursores de TAREAS'
            );

            const vr=r.data.valueRanges||[];
            const ultima=(vals)=>{
                const a=Array.isArray(vals)?vals:[];
                let n=1;
                for(let i=0;i<a.length;i++){
                    if(texto(a[i])) n=i+1;
                }
                return Math.max(1,n);
            };

            cursorSheets.tareas=ultima(vr[0]?.values?.[0]);
            cursorSheets.tareasArticulos=ultima(vr[1]?.values?.[0]);
            cursorSheets.tareasColores=ultima(vr[2]?.values?.[0]);
            cursorSheets.lista=true;

            console.log('🧠 CURSORES TAREAS:',{
                tareas:cursorSheets.tareas,
                tareasArticulos:cursorSheets.tareasArticulos,
                tareasColores:cursorSheets.tareasColores
            });
        } catch(error) {
            console.error('⚠️ No se pudieron inicializar los cursores:',error.message);
        } finally {
            cursorSheets.inicializando=null;
        }
    })();

    return cursorSheets.inicializando;
}

function siguienteFilaCursor(nombre) {
    return Math.max(2,(Number(cursorSheets[nombre])||1)+1);
}

function avanzarCursor(nombre, ultimaFila) {
    const n=Number(ultimaFila);
    if(Number.isFinite(n) && n>Number(cursorSheets[nombre]||1)){
        cursorSheets[nombre]=n;
    }
}

function estadoArticuloParaGuardar(art){
    // La columna G de TAREAS_ARTICULOS se usa como FECHA DE SALIDA.
    // Al crear/editar una tarea sin retiro todavía queda vacía.
    // Cuando se retira desde REGISTRAR SALIDA, app.js envía fechaSalida
    // y esa fecha se conserva en G.
    return texto(art?.fechaSalida);
}

async function escribirTareaCompleta(tarea, opciones={}) {
    if (!sheets) throw new Error('Google Sheets no está conectado.');

    // ============================================================
    // GUARDADO SEGURO DE TAREAS_ARTICULOS
    //
    // REGLAS:
    // 1) ID_ARTICULO_TAREA = ID_TAREA-ARTICULO-N
    // 2) N empieza en 1 para cada artículo dentro de la tarea.
    // 3) Al editar, agregar o quitar artículos se reconstruye
    //    SOLAMENTE el bloque de esa tarea.
    // 4) El bloque queda compacto y ordenado por artículo.
    // 5) TAREAS_COLORES NO SE TOCA en esta rutina.
    // 6) Si un artículo tiene MOVIMIENTO_ID, NO se borra ni se
    //    renumera su identidad histórica.
    // ============================================================

    await inicializarCursoresSheets();

    let datos=null;
    let filasTareas=[];
    let filasArticulos=[];
    let filasColores=[];

    const idTarea = baseIdTareaPorFecha(texto(tarea.fecha));
    if (!idTarea) throw new Error('La fecha de la tarea no es válida.');

    // Alta normal: el frontend ya sabe que es una tarea nueva.
    // NO leemos TAREAS_ARTICULOS/TAREAS_COLORES.
    // Edición: se lee la estructura existente para reconstruir SOLO
    // el bloque de la tarea editada.
    const esNueva=opciones.nueva===true;

    if(!esNueva){
        datos=await obtenerDatosTareasEnBloque();
        filasTareas=datos.tareas||[];
        filasArticulos=datos.articulos||[];
        filasColores=datos.colores||[];
    }

    const existenteIndex=esNueva
        ? -1
        : filasTareas.findIndex(
            f => normalizarIdTarea(f?.[0]) === idTarea
          );

    const filaTareaReal =
        existenteIndex >= 0
            ? existenteIndex + 2
            : siguienteFilaCursor('tareas');

    const colores = Array.isArray(tarea.colores) ? tarea.colores : [];
    const articulosEntrantes = Array.isArray(tarea.articulos)
        ? tarea.articulos
        : [];

    const cantidad = numero(tarea.cantidad);

    // EL COLOR BASE SALE EXCLUSIVAMENTE DE TAREAS!D.
    // Nunca se deriva de TAREAS_COLORES.
    const color = texto(tarea.color).toUpperCase();
    if (!color) {
        throw new Error('La tarea no tiene COLOR BASE.');
    }

    const estado = esNueva
        ? 'PENDIENTE'
        : (normalizarTexto(tarea.estado)==='COMPLETO' ? 'COMPLETO' : 'PENDIENTE');

    const requests = [];

    // Actualizar/crear la fila principal de TAREAS.
    requests.push({
        range: `TAREAS!A${filaTareaReal}:E${filaTareaReal}`,
        values: [[
            idTarea,
            texto(tarea.fecha),
            String(cantidad),
            color,
            estado
        ]]
    });

    // ------------------------------------------------------------
    // LEER ARTÍCULOS EXISTENTES DE ESTA TAREA.
    // ------------------------------------------------------------
    const actualesArt = filasArticulos
        .map((fila, i) => ({
            filaReal: i + 2,
            id: texto(fila?.[0]),
            idTarea: normalizarIdTarea(fila?.[1]),
            articulo: texto(fila?.[2]),
            taller: texto(fila?.[3]).toUpperCase(),
            cantidad: numero(fila?.[4]),
            color: texto(fila?.[5]).toUpperCase(),
            fechaSalida: texto(fila?.[6]),
            movimientoId: texto(fila?.[7])
        }))
        .filter(x => x.idTarea === idTarea);

    // ------------------------------------------------------------
    // Agrupar existentes por artículo.
    // ------------------------------------------------------------
    const existentesPorArticulo = new Map();

    for (const viejo of actualesArt) {
        const base = normalizarArticuloParaId(viejo.articulo);
        if (!base) continue;

        if (!existentesPorArticulo.has(base)) {
            existentesPorArticulo.set(base, []);
        }

        existentesPorArticulo.get(base).push(viejo);
    }

    // Mantener el orden actual de cada grupo.
    for (const lista of existentesPorArticulo.values()) {
        lista.sort((a, b) => {
            const na = Number((a.id.match(/-(\d+)$/) || [,'999999'])[1]);
            const nb = Number((b.id.match(/-(\d+)$/) || [,'999999'])[1]);
            return na - nb || a.filaReal - b.filaReal;
        });
    }

    // ------------------------------------------------------------
    // Normalizar la lista entrante.
    // La numeración se calcula NUEVAMENTE por artículo.
    // ------------------------------------------------------------
    const entrantes = articulosEntrantes
        .map((art, indiceOriginal) => ({
            ...art,
            __indiceOriginal: indiceOriginal,
            articulo: texto(art.articulo),
            base: normalizarArticuloParaId(art.articulo)
        }))
        .filter(a => a.base);

    // Orden de artículos: menor a mayor. Para iguales, conserva
    // el orden en que aparecen en la tarea.
    entrantes.sort((a, b) => {
        const na = Number(a.articulo);
        const nb = Number(b.articulo);

        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
            return na - nb;
        }

        const cmp = a.articulo.localeCompare(
            b.articulo,
            'es',
            { numeric: true, sensitivity: 'base' }
        );

        return cmp || a.__indiceOriginal - b.__indiceOriginal;
    });

    // ------------------------------------------------------------
    // Para cada artículo:
    // - si ya existe una fila libre con ese artículo, conserva su ID
    // - si no, crea el siguiente ID
    //
    // IMPORTANTE: el número se basa en la posición dentro de la
    // lista actual del artículo, no en "IDs ocupados" históricos.
    // ------------------------------------------------------------
    const usadosViejos = new Set();
    const filasFinales = [];

    const contadorPorArticulo = new Map();

    for (const art of entrantes) {
        const base = art.base;
        const numeroArticulo = (contadorPorArticulo.get(base) || 0) + 1;
        contadorPorArticulo.set(base, numeroArticulo);

        const disponiblesViejos =
            (existentesPorArticulo.get(base) || [])
                .filter(v => !usadosViejos.has(v.filaReal));

        // Preferimos la fila histórica correspondiente a la misma
        // posición. Esto evita cambiar -1 por -2 al editar una
        // propiedad que no tiene relación con el artículo.
        const viejo = disponiblesViejos[0] || null;

        let idArt;
        if (viejo) {
            idArt = viejo.id;
            usadosViejos.add(viejo.filaReal);
        } else {
            idArt = `${idTarea}-${base}-${numeroArticulo}`;
        }

        // Si por datos antiguos el ID existente no coincide con la
        // numeración deseada, lo corregimos solamente si NO tiene
        // movimiento. Con movimiento, preservamos identidad histórica.
        const idDeseado = `${idTarea}-${base}-${numeroArticulo}`;

        if (viejo && viejo.movimientoId) {
            idArt = viejo.id;
        } else {
            idArt = idDeseado;
        }

        filasFinales.push({
            art,
            viejo,
            idArt,
            numeroArticulo
        });
    }

    // ------------------------------------------------------------
    // Filas antiguas que desaparecieron de la edición.
    //
    // Sin MOVIMIENTO_ID: se eliminan físicamente de la hoja.
    // Con MOVIMIENTO_ID: se conservan intactas.
    // ------------------------------------------------------------
    const filasHistoricasAConservar = actualesArt.filter(
        viejo => viejo.movimientoId && !usadosViejos.has(viejo.filaReal)
    );

    // ------------------------------------------------------------
    // IMPORTANTE:
    // Para que NO queden huecos ni artículos movidos al azar,
    // reconstruimos compactamente SOLO el bloque de la tarea.
    //
    // Primero limpiamos las filas actuales de la tarea.
    // Después escribimos el bloque final consecutivamente.
    //
    // Las filas con MOVIMIENTO_ID que no forman parte de la lista
    // entrante se conservan con su contenido, pero se ubican en el
    // bloque de la tarea sin alterar su ID.
    // ------------------------------------------------------------
    const filasActualesOrdenadas = actualesArt
        .slice()
        .sort((a, b) => a.filaReal - b.filaReal);

    // Si hay históricos con movimiento que ya no están en la tarea
    // entrante, los añadimos al final del bloque para no perderlos.
    const finalConHistoricos = [
        ...filasFinales,
        ...filasHistoricasAConservar.map(viejo => ({
            art: {
                articulo: viejo.articulo,
                taller: viejo.taller,
                cantidad: viejo.cantidad,
                color: viejo.color,
                fechaSalida: viejo.fechaSalida,
                movimientoId: viejo.movimientoId
            },
            viejo,
            idArt: viejo.id,
            numeroArticulo: null,
            historico: true
        }))
    ];

    // El bloque final se ordena por artículo; los históricos quedan
    // con su identidad y después de los activos del mismo artículo.
    finalConHistoricos.sort((a, b) => {
        const aa = Number(a.art.articulo);
        const bb = Number(b.art.articulo);

        if (Number.isFinite(aa) && Number.isFinite(bb) && aa !== bb) {
            return aa - bb;
        }

        return String(a.art.articulo).localeCompare(
            String(b.art.articulo),
            'es',
            { numeric: true, sensitivity: 'base' }
        );
    });

    // ------------------------------------------------------------
    // Si no hay artículos con movimiento y el bloque existe,
    // lo compactamos físicamente.
    // ------------------------------------------------------------
    const filasFisicas = actualesArt.map(x => x.filaReal);

    if (filasFisicas.length) {
        const minFila = Math.min(...filasFisicas);

        // Limpiamos únicamente A:H de las filas que pertenecían a
        // esta tarea. Luego escribimos el bloque compacto.
        for (const filaReal of filasFisicas) {
            requests.push({
                range: `TAREAS_ARTICULOS!A${filaReal}:H${filaReal}`,
                values: [['','','','','','','','']]
            });
        }

        for (let i = 0; i < finalConHistoricos.length; i++) {
            const item = finalConHistoricos[i];
            const art = item.art;

            const valores = [
                item.idArt,
                idTarea,
                texto(art.articulo),
                texto(art.taller).toUpperCase(),
                String(numero(art.cantidad) || cantidad),
                color,
                estadoArticuloParaGuardar(art),
                texto(art.movimientoId)
            ];

            requests.push({
                range: `TAREAS_ARTICULOS!A${minFila + i}:H${minFila + i}`,
                values: [valores]
            });
        }
    } else if (finalConHistoricos.length) {
        const filaInicio = esNueva
            ? siguienteFilaCursor('tareasArticulos')
            : ultimaFilaConDatos(filasArticulos) + 1;

        for (let i = 0; i < finalConHistoricos.length; i++) {
            const item = finalConHistoricos[i];
            const art = item.art;

            requests.push({
                range: `TAREAS_ARTICULOS!A${filaInicio + i}:H${filaInicio + i}`,
                values: [[
                    item.idArt,
                    idTarea,
                    texto(art.articulo),
                    texto(art.taller).toUpperCase(),
                    String(numero(art.cantidad) || cantidad),
                    color,
                    estadoArticuloParaGuardar(art),
                    texto(art.movimientoId)
                ]]
            });
        }
    } else {
        // Nueva tarea sin artículos: no escribir nada en
        // TAREAS_ARTICULOS.
    }

    // ------------------------------------------------------------
    // TAREAS_COLORES:
    // Se mantiene la lógica existente de la hoja.
    // NO se cambia su estructura.
    // ------------------------------------------------------------
    const actualesCol = filasColores
        .map((fila, i) => ({
            filaReal: i + 2,
            idTarea: normalizarIdTarea(fila?.[0])
        }))
        .filter(x => x.idTarea === idTarea);

    for (const viejo of actualesCol) {
        requests.push({
            range: `TAREAS_COLORES!A${viejo.filaReal}:C${viejo.filaReal}`,
            values: [['','','']]
        });
    }

    const nuevosCol = [];
    for (const c of colores) {
        const cc = texto(c.color).toUpperCase();
        const qty = numero(c.cantidad);
        if (!cc || qty <= 0) continue;

        nuevosCol.push([idTarea, cc, String(qty)]);
    }

    if (nuevosCol.length) {
        const filaInicio = esNueva
            ? siguienteFilaCursor('tareasColores')
            : ultimaFilaConDatos(filasColores) + 1;

        for (let i = 0; i < nuevosCol.length; i++) {
            requests.push({
                range: `TAREAS_COLORES!A${filaInicio + i}:C${filaInicio + i}`,
                values: [nuevosCol[i]]
            });
        }
    }

    if (requests.length) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: GOOGLE_SHEET_ID,
            requestBody: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        });

        avanzarCursor('tareas',filaTareaReal);

        if(esNueva){
            if(finalConHistoricos.length){
                const inicio=siguienteFilaCursor('tareasArticulos');
                avanzarCursor(
                    'tareasArticulos',
                    inicio+finalConHistoricos.length-1
                );
            }
            if(nuevosCol.length){
                const inicio=siguienteFilaCursor('tareasColores');
                avanzarCursor(
                    'tareasColores',
                    inicio+nuevosCol.length-1
                );
            }
        }
    }

    return {
        id: idTarea,
        fecha: texto(tarea.fecha),
        cantidad,
        color,
        estado,
        articulos: finalConHistoricos.map(x => ({
            id: x.idArt,
            articulo: texto(x.art.articulo),
            taller: texto(x.art.taller).toUpperCase(),
            cantidad: numero(x.art.cantidad) || cantidad,
            color: texto(x.art.color).toUpperCase(),
            estado: estadoArticuloParaGuardar(x.art),
            fechaSalida: texto(x.art.fechaSalida),
            movimientoId: texto(x.art.movimientoId)
        })),
        colores: nuevosCol.map(x => ({
            color: x[1],
            cantidad: numero(x[2])
        }))
    };
}


app.get('/api/tareas',async(req,res)=>{
    try{
        const tareas=await obtenerTareasCentralizadas();
        res.json({success:true,tareas:tareas.map(tareaParaCliente)});
    }catch(error){
        console.error('❌ ERROR /api/tareas:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.post('/api/tareas',async(req,res)=>{
    try{
        if(!req.body?.tarea){
            return res.status(400).json({success:false,error:'Tarea requerida.'});
        }
        const guardada=await escribirTareaCompleta(req.body.tarea,{nueva:true});
        res.json({success:true,tarea:tareaParaCliente(guardada)});
    }catch(error){
        console.error('❌ ERROR POST /api/tareas:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.delete('/api/tareas/:id',async(req,res)=>{
    try{
        const id=texto(req.params.id);
        const tareas=await obtenerTareasCentralizadas();
        const tarea=tareas.find(x=>x.id===id);
        if(!tarea)return res.status(404).json({success:false,error:'Tarea no encontrada.'});

        const vinculados=(tarea.articulos||[]).filter(x=>texto(x.movimientoId));
        if(vinculados.length){
            return res.status(409).json({
                success:false,
                error:'La tarea tiene salidas vinculadas a BD. Primero revertí esas salidas.'
            });
        }

        // Conservamos el comportamiento existente por seguridad.
        await eliminarFilasPorIndices('TAREAS_ARTICULOS',tarea.articulos.map(x=>x.fila));
        await eliminarFilasPorIndices('TAREAS_COLORES',tarea.colores.map(x=>x.fila));
        await borrarFila('TAREAS',tarea.fila);

        res.json({success:true});
    }catch(error){
        console.error('❌ ERROR DELETE /api/tareas:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

app.put('/api/tareas/articulos/:id',async(req,res)=>{
    try{
        const id=texto(req.params.id);
        const tareas=await obtenerTareasCentralizadas();
        let encontrado=null;

        for(const tarea of tareas){
            const art=(tarea.articulos||[]).find(x=>x.id===id);
            if(art){encontrado={tarea,art};break;}
        }

        if(!encontrado){
            return res.status(404).json({success:false,error:'Artículo de tarea no encontrado.'});
        }

        const {tarea,art}=encontrado;
        const taller=req.body?.taller!==undefined
            ? texto(req.body.taller).toUpperCase():art.taller;
        const fechaSalida=req.body?.fechaSalida!==undefined
            ? texto(req.body.fechaSalida):art.fechaSalida;
        const movimientoId=req.body?.movimientoId!==undefined
            ? texto(req.body.movimientoId):art.movimientoId;
        await sheetsConReintento(
            ()=>actualizarFilaRango('TAREAS_ARTICULOS',art.fila,[
                art.id,tarea.id,art.articulo,taller,
                String(art.cantidad||tarea.cantidad||0),
                texto(art.color).toUpperCase() || texto(tarea.color).toUpperCase(),
                fechaSalida,movimientoId
            ]),
            'Actualización de artículo de TAREA'
        );

        const estado=fechaSalida
            ? 'ENTREGADO'
            : (taller ? 'RESERVADO' : 'SIN TALLER');

        res.json({success:true,articulo:{...art,taller,estado,fechaSalida,movimientoId}});
    }catch(error){
        console.error('❌ ERROR PUT /api/tareas/articulos/:id:',error);
        res.status(500).json({success:false,error:error.message});
    }
});

async function desvincularMovimientoDeTarea(movimientoId){
    const id=texto(movimientoId);
    if(!id)return 0;

    const tareas=await obtenerTareasCentralizadas();
    let cambios=0;

    for(const tarea of tareas){
        for(const art of tarea.articulos||[]){
            if(texto(art.movimientoId)!==id)continue;

            await sheetsConReintento(
                ()=>actualizarFilaRango('TAREAS_ARTICULOS',art.fila,[
                    art.id,tarea.id,art.articulo,art.taller,
                    String(art.cantidad||tarea.cantidad||0),
                    texto(art.color).toUpperCase() || texto(tarea.color).toUpperCase(),
                    '', ''
                ]),
                'Desvinculación de TAREA'
            );
            cambios++;
        }
    }
    return cambios;
}

app.put('/api/tareas/sync',async(req,res)=>{
    try{
        const entrantes=Array.isArray(req.body?.tareas)?req.body.tareas:[];
        const actuales=await obtenerTareasCentralizadas();
        const idsEntrantes=new Set();
        const idsTareasOcupados=new Set(actuales.map(t=>texto(t.id)).filter(Boolean));

        for(let i=0;i<entrantes.length;i++){
            const tarea={...(entrantes[i]||{})};
            tarea.id=texto(tarea.id);
            if(!tarea.id){
                tarea.id=generarIdTareaPorFecha(tarea.fecha,idsTareasOcupados);
                idsTareasOcupados.add(tarea.id);
            }
            idsEntrantes.add(tarea.id);
            entrantes[i]=tarea;
            const guardada=await escribirTareaCompleta(tarea);
            entrantes[i]=guardada;
        }

        for(const actual of actuales){
            if(idsEntrantes.has(actual.id))continue;
            if((actual.articulos||[]).some(x=>texto(x.movimientoId)))continue;

            await eliminarFilasPorIndices('TAREAS_ARTICULOS',actual.articulos.map(x=>x.fila));
            await eliminarFilasPorIndices('TAREAS_COLORES',actual.colores.map(x=>x.fila));
            await borrarFila('TAREAS',actual.fila);
        }

        // Para evitar otra lectura completa, devolvemos los datos entrantes.
        res.json({success:true,tareas:entrantes.map(t=>tareaParaCliente(t))});
    }catch(error){
        console.error('❌ ERROR PUT /api/tareas/sync:',error);
        res.status(500).json({success:false,error:error.message});
    }
});


app.put('/api/tareas/:id/estado',async(req,res)=>{
    try{
        const id=normalizarIdTarea(req.params.id);
        const estado=normalizarTexto(req.body?.estado)==='COMPLETO'
            ? 'COMPLETO'
            : 'PENDIENTE';

        if(!id){
            return res.status(400).json({
                success:false,
                error:'ID de tarea inválido.'
            });
        }

        // SOLO leemos TAREAS A:E y SOLO modificamos la columna E.
        const filas=await obtenerHoja('TAREAS','A2:E');
        const indice=filas.findIndex(
            f=>normalizarIdTarea(f?.[0])===id
        );

        if(indice<0){
            return res.status(404).json({
                success:false,
                error:`No encontré la tarea ${id} en TAREAS.`
            });
        }

        const filaReal=indice+2;

        await sheetsConReintento(
            ()=>actualizarFilaRango(
                'TAREAS',
                filaReal,
                [
                    texto(filas[indice]?.[0]),
                    texto(filas[indice]?.[1]),
                    String(numero(filas[indice]?.[2])||0),
                    texto(filas[indice]?.[3]),
                    estado
                ]
            ),
            'Cambio de estado de TAREA'
        );

        res.json({
            success:true,
            tarea:{
                id:normalizarIdTarea(filas[indice]?.[0]),
                fecha:texto(filas[indice]?.[1]),
                cantidad:numero(filas[indice]?.[2]),
                color:texto(filas[indice]?.[3]).toUpperCase(),
                estado
            }
        });
    }catch(error){
        console.error('❌ ERROR PUT /api/tareas/:id/estado:',error);
        res.status(500).json({
            success:false,
            error:error.message
        });
    }
});

app.put('/api/tareas/:id',async(req,res)=>{
    try{
        const id=texto(req.params.id);
        const guardada=await escribirTareaCompleta({...req.body?.tarea,id});
        res.json({success:true,tarea:tareaParaCliente(guardada)});
    }catch(error){
        console.error('❌ ERROR PUT /api/tareas:',error);
        res.status(500).json({success:false,error:error.message});
    }
});


// ============================================================
// COMPACTAR TAREAS_ARTICULOS / TAREAS_COLORES
// Uso único después de una importación vieja que dejó huecos.
// Requiere la confirmación exacta enviada por la página auxiliar.
// ============================================================

async function compactarHojaValores(nombreHoja, columnas, confirmar){
    if(confirmar!=='COMPACTAR_GOOD_COMPANY'){
        throw new Error('Confirmación inválida.');
    }

    const respuesta=await sheetsConReintento(
        ()=>sheets.spreadsheets.values.get({
            spreadsheetId:GOOGLE_SHEET_ID,
            range:`${nombreHoja}!A2:${columnas}`
        }),
        `Lectura para compactar ${nombreHoja}`
    );

    const filas=(respuesta.data.values||[]);
    const limpias=filas.filter(fila=>
        Array.isArray(fila) &&
        fila.some(v=>String(v??'').trim()!=='')
    );

    const ultimaFilaActual=Math.max(2,filas.length+1);

    await sheetsConReintento(
        ()=>sheets.spreadsheets.values.clear({
            spreadsheetId:GOOGLE_SHEET_ID,
            range:`${nombreHoja}!A2:${columnas}${ultimaFilaActual}`
        }),
        `Limpieza ${nombreHoja}`
    );

    if(limpias.length){
        await sheetsConReintento(
            ()=>sheets.spreadsheets.values.update({
                spreadsheetId:GOOGLE_SHEET_ID,
                range:`${nombreHoja}!A2:${columnas}${limpias.length+1}`,
                valueInputOption:'USER_ENTERED',
                requestBody:{values:limpias}
            }),
            `Escritura compacta ${nombreHoja}`
        );
    }

    return {
        antes:filas.length,
        despues:limpias.length,
        eliminadas:filas.length-limpias.length
    };
}

app.post('/api/tareas/compactar',async(req,res)=>{
    try{
        if(!sheets) throw new Error('Google Sheets no está conectado.');
        const confirmar=texto(req.body?.confirmar);

        const articulos=await compactarHojaValores(
            'TAREAS_ARTICULOS','H',confirmar
        );
        const colores=await compactarHojaValores(
            'TAREAS_COLORES','C',confirmar
        );

        res.json({
            success:true,
            articulos,
            colores
        });
    }catch(error){
        console.error('❌ ERROR COMPACTANDO TAREAS:',error);
        res.status(500).json({success:false,error:error.message});
    }
});


// ============================================================
// ELIMINAR BD — DEVOLVER RESERVA VINCULADA
// ============================================================

app.delete('/api/bd/:id',async(req,res)=>{
    try{
const id=texto(req.params.id);
        const movimientos=await obtenerMovimientos();
        const movimiento=movimientos.find(x=>x.id===id);

        if(!movimiento){
            return res.status(404).json({success:false,error:'Movimiento no encontrado.'});
        }

        await borrarFila('BD',movimiento.fila);

        let desvinculados=0;
        try{
            desvinculados=await desvincularMovimientoDeTarea(id);
        }catch(errorDesvincular){
            console.error('⚠️ ERROR DEVOLVIENDO RESERVA:',errorDesvincular);
        }

        res.json({success:true,id,desvinculados});
    }catch(error){
        console.error('❌ ERROR ELIMINANDO BD:',error);
        res.status(500).json({success:false,error:error.message});
    }
});


// ============================================================
// DIAGNÓSTICO
// ============================================================

app.get(
    '/api/diagnostico',
    (
        req,
        res
    ) => {

        res.json({

            success:
                true,

            servidor:
                'GOOD COMPANY',

            baseDatos:
                'GOOGLE SHEETS',

            pendientes:
                true,

            rutaPendientes:
                '/api/talleres/:tallerId/pendientes',

            hojas: [

                'BD',

                'TALLERES',

                'COLORES',

                'COSTOS',

                'ADELANTOS',

                'TAREAS',

                'TAREAS_ARTICULOS',

                'TAREAS_COLORES'

            ],

            sheetId:
                GOOGLE_SHEET_ID

        });

    }
);

// ============================================================
// STATUS
// ============================================================

app.get(
    '/api/status',
    (
        req,
        res
    ) => {

        res.json({

            success:
                true,

            servidor:
                'GOOD COMPANY',

            googleSheets:
                sheets !== null,

            baseDatos:
                'GOOGLE SHEETS',

            hojas: [

                'BD',

                'TALLERES',

                'COLORES',

                'COSTOS',

                'ADELANTOS'

            ]

        });

    }
);

// ============================================================
// GET /api/pagos/historial
// ============================================================

app.get(
    '/api/pagos/historial',
    async (
        req,
        res
    ) => {

        try {

            const movimientos =
                await obtenerMovimientos();

            const historial =
                movimientos
                    .filter(
                        movimiento => {

                            // SOLAMENTE ENTRA
                            if (
                                normalizarTexto(
                                    movimiento.movimiento
                                ) !== 'ENTRA'
                            ) {

                                return false;

                            }

                            // SOLAMENTE PAGADO = SI
                            if (
                                !esSi(
                                    movimiento.pagado
                                )
                            ) {

                                return false;

                            }

                            // SOLAMENTE FINALIZADO = SI
                            if (
                                !esSi(
                                    movimiento.finalizado
                                )
                            ) {

                                return false;

                            }

                            // DEBE TENER TALLER
                            if (
                                !texto(
                                    movimiento.taller
                                )
                            ) {

                                return false;

                            }

                            return true;

                        }
                    )
                    .map(
                        movimiento => {

                            const tipo =
                                obtenerTipoPago(
                                    movimiento
                                );

                            return {

                                id:
                                    movimiento.id,

                                fila:
                                    movimiento.fila,

                                fecha:
                                    movimiento.fecha,

                                hora:
                                    movimiento.hora,

                                taller:
                                    movimiento.taller,

                                articulo:
                                    movimiento.articulo,

                                cantidad:
                                    movimiento.cantidad,

                                color:
                                    movimiento.color,

                                movimiento:
                                    movimiento.movimiento,

                                reparacion:
                                    movimiento.reparacion,

                                sin_armar:
                                    movimiento.sin_armar,

                                muestra:
                                    movimiento.muestra,

                                pagado:
                                    movimiento.pagado,

                                finalizado:
                                    movimiento.finalizado,

                                tipo_pago:
                                    tipo,

                                abonable:
                                    tipo === 'NORMAL',

                                orden:
                                    fechaHoraParaOrden(
                                        movimiento.fecha,
                                        movimiento.hora
                                    )

                            };

                        }
                    )
                    .sort(
                        (
                            a,
                            b
                        ) => {

                            return (
                                b.orden -
                                a.orden
                            );

                        }
                    );


            // =================================================
            // SACAR TALLERES DEL HISTORIAL
            // =================================================

            const talleres =
                Array.from(
                    new Set(
                        historial
                            .map(
                                item =>
                                    texto(
                                        item.taller
                                    )
                            )
                            .filter(
                                Boolean
                            )
                    )
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        a.localeCompare(
                            b,
                            'es',
                            {
                                sensitivity:
                                    'base'
                            }
                        )
                );


            console.log(
                '📜 HISTORIAL:',
                historial.length,
                'movimientos'
            );

            console.log(
                '🏭 TALLERES HISTORIAL:',
                talleres
            );


            res.json({

                success:
                    true,

                movimientos:
                    historial,

                historial:
                    historial,

                talleres:
                    talleres

            });

        } catch (
            error
        ) {

            console.error(
                '❌ ERROR HISTORIAL PAGOS:',
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);




// ============================================================
// API — INFORME EXCEL DESDE HISTORIAL DE PAGOS
// Lectura puntual: solo cuando el usuario pulsa EXPORTAR EXCEL.
// No modifica Google Sheets.
// ============================================================

app.get(
    '/api/pagos/historial-reporte',
    async (req, res) => {
        try {
            const tallerFiltro = normalizarTexto(req.query?.taller);
            const anioFiltro = texto(req.query?.anio);
            const mesFiltro = texto(req.query?.mes);

            if (!tallerFiltro || !anioFiltro || !mesFiltro || mesFiltro === 'TODOS') {
                return res.status(400).json({
                    success: false,
                    error: 'Taller, año y mes son obligatorios.'
                });
            }

            const movimientos = await obtenerMovimientos();

            function partesFechaInforme(valor) {
                const s = texto(valor);
                let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
                if (m) {
                    return { anio: m[3], mes: String(Number(m[2])).padStart(2, '0'), dia: Number(m[1]) };
                }
                m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
                if (m) {
                    return { anio: m[1], mes: String(Number(m[2])).padStart(2, '0'), dia: Number(m[3]) };
                }
                return { anio: '', mes: '', dia: 0 };
            }

            const filtrados = movimientos.filter(movimiento => {
                if (normalizarTexto(movimiento.taller) !== tallerFiltro) return false;

                const p = partesFechaInforme(movimiento.fecha);
                if (p.anio !== anioFiltro) return false;
                if (p.mes !== String(Number(mesFiltro)).padStart(2, '0')) return false;

                const tipoMovimiento = normalizarTexto(movimiento.movimiento);

                // Para INGRESOS solo exportamos movimientos que ya fueron
                // pagados y finalizados. Los EGRESOS normales (SALE sin
                // BOLETA/REMIS) son salidas de mercadería y no dependen de
                // PAGADO/FINALIZADO para aparecer en este informe.
                if (tipoMovimiento === 'ENTRA') {
                    if (!esSi(movimiento.pagado) || !esSi(movimiento.finalizado)) return false;
                } else if (tipoMovimiento !== 'SALE') {
                    return false;
                }

                const reparacion = normalizarTexto(movimiento.reparacion) === 'SI';
                const muestra =
                    normalizarTexto(movimiento.muestra) === 'SI' ||
                    normalizarTexto(movimiento.color) === 'MUESTRA';
                const sinArmar = normalizarTexto(movimiento.sin_armar) === 'SI';

                // EGRESOS = historial de todas las SALE del taller.
                // Solo se excluyen REPARACIONES y MUESTRAS.
                // S/ARMAR sigue figurando como egreso porque también salió mercadería.
                if (tipoMovimiento === 'SALE') {
                    if (reparacion || muestra) return false;
                } else if (tipoMovimiento === 'ENTRA') {
                    if (reparacion || muestra || sinArmar) return false;
                } else {
                    return false;
                }

                return tipoMovimiento === 'ENTRA' || tipoMovimiento === 'SALE';
            });

            res.json({
                success: true,
                movimientos: filtrados
            });
        } catch (error) {
            console.error('❌ ERROR /api/pagos/historial-reporte:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// ============================================================
// API — ARTÍCULOS DISPONIBLES PARA SALIDA DESDE INDEX
//
// DISPONIBLE = TAREAS_ARTICULOS sin taller, sin fecha de salida
// y sin MOVIMIENTO_ID.
//
// Se devuelve cada producción individual con su ID exacto,
// para que dos artículos iguales de tareas diferentes no se mezclen.
//
// ORDEN:
//   1) ARTÍCULO menor -> mayor
//   2) FECHA DE PRODUCCIÓN más antigua -> más nueva
// ============================================================

app.get('/api/tareas/disponibles',async(req,res)=>{
    try{
        const tareas=await obtenerTareasCentralizadas();
        const disponibles=[];

        for(const tarea of tareas){

            // PENDIENTE / EN PRODUCCIÓN nunca entra en INDEX.
            if(normalizarTexto(tarea.estado)!=='COMPLETO') continue;

            for(const art of (tarea.articulos||[])){

                const taller=texto(art.taller);
                const movimientoId=texto(art.movimientoId);
                const estadoArticulo=normalizarTexto(art.estado);

                // Solo verdaderamente DISPONIBLES.
                if(taller || movimientoId || estadoArticulo==='ENTREGADO') continue;

                // INDEX representa la TAREA, no el desglose interno de colores.
                // La cantidad y el color son los datos base de TAREAS.
                const cantidad=numero(tarea.cantidad);
                const color=texto(tarea.color).toUpperCase();

                disponibles.push({
                    idArticuloTarea:texto(art.id),
                    idTarea:texto(tarea.id),
                    articulo:texto(art.articulo),
                    cantidad,
                    color,
                    fechaProduccion:texto(tarea.fecha)
                });
            }
        }

        function fechaOrden(valor){
            const s=texto(valor);

            // ISO / Google Sheets: YYYY-MM-DD...
            let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            if(m){
                const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]);
                const t=new Date(y,mo-1,d).getTime();
                return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
            }

            // Formato argentino: D/M/YYYY o DD/MM/YYYY.
            m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if(m){
                const d=Number(m[1]), mo=Number(m[2]), y=Number(m[3]);
                const t=new Date(y,mo-1,d).getTime();
                return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
            }

            return Number.MAX_SAFE_INTEGER;
        }

        disponibles.sort((a,b)=>{
            // ORDEN DEFINITIVO:
            // 1) FECHA DE TAREA: más antigua -> más nueva
            // 2) ARTÍCULO: menor -> mayor
            const fechaA=fechaOrden(a.fechaProduccion);
            const fechaB=fechaOrden(b.fechaProduccion);

            if(fechaA!==fechaB){
                return fechaA-fechaB;
            }

            const aa=String(a.articulo||'').trim();
            const bb=String(b.articulo||'').trim();

            const na=Number(aa);
            const nb=Number(bb);

            if(Number.isFinite(na) && Number.isFinite(nb) && na!==nb){
                return na-nb;
            }

            const cmpArticulo=aa.localeCompare(
                bb,
                'es',
                {numeric:true,sensitivity:'base'}
            );

            if(cmpArticulo!==0) return cmpArticulo;

            return String(a.idArticuloTarea||'').localeCompare(
                String(b.idArticuloTarea||''),
                'es',
                {numeric:true,sensitivity:'base'}
            );
        });

        res.json({
            success:true,
            disponibles
        });

    }catch(error){
        console.error('❌ ERROR /api/tareas/disponibles:',error);
        res.status(500).json({
            success:false,
            error:error.message
        });
    }
});

// ============================================================
// API — DATOS PARA INFORME DE PRODUCCIÓN
//
// Accesible con permiso PRODUCCION.
// Lee TAREAS + TAREAS_ARTICULOS una sola vez al solicitar
// el informe y devuelve únicamente artículos que todavía no
// tienen salida (sin fecha de salida ni MOVIMIENTO_ID).
//
// ESTADO:
//   - sin taller  -> DISPONIBLE
//   - con taller  -> RESERVADO
//
// TAREAS_ARTICULOS NO SE MODIFICA.
// ============================================================

app.get('/api/produccion/informe',async(req,res)=>{
    try{
        const tareas=await obtenerTareasCentralizadas();
        const salida=[];

        for(const tarea of tareas){

            /*
             * ESTE ENDPOINT ES EXCLUSIVO DEL INFORME DE PRODUCCIÓN.
             *
             * A diferencia de /api/tareas/disponibles (INDEX), acá
             * necesitamos VER TODO LO QUE TODAVÍA ESTÁ FÍSICAMENTE
             * EN LA FÁBRICA:
             *
             * - TAREA PENDIENTE
             * - TAREA COMPLETA
             *
             * No importa si tiene taller reservado o no.
             *
             * INDEX conserva su lógica actual y SIGUE MOSTRANDO
             * solamente las tareas COMPLETAS en "DISPONIBLES".
             */

            const estadoTarea =
                normalizarTexto(tarea.estado);

            if(
                estadoTarea !== 'COMPLETO' &&
                estadoTarea !== 'PENDIENTE'
            ){
                continue;
            }

            for(const art of (tarea.articulos||[])){

                const taller=texto(art.taller);
                const fechaSalida=texto(art.fechaSalida);
                const movimientoId=texto(art.movimientoId);

                /*
                 * Si ya salió de fábrica, no pertenece a
                 * DISPONIBLES EN PRODUCCIÓN.
                 *
                 * FECHA_SALIDA o MOVIMIENTO_ID indican que esa
                 * producción ya fue retirada.
                 */
                if(fechaSalida || movimientoId) continue;

                let color=texto(art.color).toUpperCase();

                if(
                    !color &&
                    Array.isArray(tarea.colores) &&
                    tarea.colores.length===1
                ){
                    color=texto(
                        tarea.colores[0].color
                    ).toUpperCase();
                }

                if(!color){
                    color=texto(
                        tarea.color
                    ).toUpperCase();
                }

                salida.push({
                    idArticuloTarea:texto(art.id),
                    idTarea:texto(tarea.id),
                    articulo:texto(art.articulo),
                    cantidad:
                        numero(art.cantidad) ||
                        numero(tarea.cantidad),
                    color,
                    estado:
                        taller
                            ? 'RESERVADO'
                            : 'DISPONIBLE',
                    taller,
                    fechaTarea:texto(tarea.fecha),
                    estadoTarea:estadoTarea
                });
            }
        }

        res.json({
            success:true,
            tareas:salida
        });

    }catch(error){
        console.error(
            '❌ ERROR /api/produccion/informe:',
            error
        );

        res.status(500).json({
            success:false,
            error:error.message
        });
    }
});

// ============================================================
// API — HISTORIAL DE PRODUCCIONES PARA PAGOS
//
// 2019-2025 siguen viniendo del histórico que maneja pagos.html.
// 2026 se obtiene exclusivamente desde TAREAS /
// TAREAS_ARTICULOS / TAREAS_COLORES de Google Sheets.
//
// SOLO LECTURA: este endpoint no modifica ninguna hoja.
// ============================================================

app.get('/api/pagos/historial-producciones',async(req,res)=>{
    try{
        const tareas=await obtenerTareasCentralizadas();

        res.json({
            success:true,
            tareas:tareas.map(tareaParaCliente)
        });

    }catch(error){
        console.error(
            '❌ ERROR /api/pagos/historial-producciones:',
            error
        );

        res.status(500).json({
            success:false,
            error:error.message
        });
    }
});

// ============================================================
// 404 API
// ============================================================

app.use(
    '/api',
    (
        req,
        res
    ) => {

        res.status(404).json({

            success:
                false,

            error:
                `Ruta API no encontrada: ${req.method} ${req.originalUrl}`

        });

    }
);

// ============================================================
// 404 GENERAL
// ============================================================

app.use(
    (
        req,
        res
    ) => {

        res.status(404).send(
            'Página no encontrada.'
        );

    }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function iniciarServidor() {

    console.log('');

    console.log(
        '================================================'
    );

    console.log(
        ' GOOD COMPANY'
    );

    console.log(
        ' SERVIDOR NODE.JS'
    );

    console.log(
        '================================================'
    );

    console.log(
        '📊 BASE DE DATOS: GOOGLE SHEETS'
    );

    console.log(
        '🚫 SUPABASE: DESACTIVADO'
    );

    console.log(
        '📄 CREDENCIALES: google-credentials.json'
    );

    console.log(
        '💰 PAGOS: API DE TALLERES ACTIVA'
    );

    console.log(
        '================================================'
    );

    console.log('');

    await conectarGoogleSheets();

    app.listen(
        PORT,
        () => {

            console.log('');

            console.log(
                '================================================'
            );

            console.log(
                '🚀 GOOD COMPANY FUNCIONANDO'
            );

            console.log(
                `🌐 http://localhost:${PORT}`
            );

            console.log(
                '================================================'
            );

            console.log('');

        }
    );

}

iniciarServidor();