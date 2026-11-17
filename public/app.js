


function mostrarToast(mensaje, duracion = 2000) {
    let toast = document.getElementById('gc-toast');

    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'gc-toast';
        toast.className = 'gc-toast';
        document.body.appendChild(toast);
    }

    toast.textContent = mensaje;
    toast.classList.add('show');

    clearTimeout(window.__gcToastTimer);
    window.__gcToastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, duracion);
}


// ============================================================
// NOTIFICACIONES WINDOWS — GOOD COMPANY
// IMPORTANTE: no usamos new Notification() en APP.JS.
// El único aviso visual de Windows lo genera public/sw.js mediante Web Push.
// ============================================================
// Se registra el Service Worker y, si Windows/Edge ya dio permiso,
// se mantiene la suscripción push automáticamente.
// ============================================================

let gcRegistroServiceWorkerPromise = null;

function registrarServiceWorkerGoodCompany(){
    if(!('serviceWorker' in navigator)){
        console.warn('⚠️ Este navegador no dispone de Service Worker.');
        return Promise.resolve(null);
    }

    if(!gcRegistroServiceWorkerPromise){
        gcRegistroServiceWorkerPromise =
            navigator.serviceWorker.register(
                '/sw.js?gc=1',
                { scope: '/' }
            )
            .then(async registro => {
                console.log(
                    '🔔 GOOD COMPANY — Service Worker registrado:',
                    registro.scope
                );

                // Pedimos al navegador que compruebe si hay una versión nueva.
                try{
                    await registro.update();
                }catch(_){}

                return registro;
            })
            .catch(error => {
                console.error(
                    '❌ GOOD COMPANY — NO SE PUDO REGISTRAR /sw.js:',
                    error
                );
                return null;
            });
    }

    return gcRegistroServiceWorkerPromise;
}

async function inicializarNotificacionesWindows(){

    try{
        // IMPORTANTE:
        // El Service Worker se registra SIEMPRE, independientemente
        // de que PushManager o el permiso de notificaciones estén listos.
        const registro =
            await registrarServiceWorkerGoodCompany();

        if(!registro){
            return;
        }

        if(!('PushManager' in window)){
            console.warn(
                '⚠️ Este navegador no soporta PushManager.'
            );
            return;
        }

        if(!('Notification' in window)){
            console.warn(
                '⚠️ Este navegador no dispone de Notification API.'
            );
            return;
        }

        if(Notification.permission === 'denied'){
            console.warn(
                '⚠️ Las notificaciones de Good Company están bloqueadas en Edge.'
            );
            return;
        }

        if(Notification.permission === 'default'){
            // No pedimos permiso automáticamente al cargar.
            // Edge puede exigir una acción del usuario.
            console.log(
                'ℹ️ GOOD COMPANY — permiso de notificaciones todavía no concedido.'
            );
            return;
        }

        // Primero comprobamos el permiso REAL del usuario en USUARIOS.
        // Solo PAGOS=SI puede quedar suscripto a estos avisos.
        const respuestaPermisos = await fetch(
            '/api/notificaciones/permisos',
            {
                method:'GET',
                cache:'no-store',
                credentials:'same-origin'
            }
        );

        if(!respuestaPermisos.ok){
            console.warn('⚠️ GOOD COMPANY — no se pudieron consultar los permisos de notificaciones.');
            return;
        }

        const permisos = await respuestaPermisos.json();

        if(!permisos.puedeRecibirPagos){
            // Si esta PC ya tenía una suscripción anterior, la damos de baja
            // para que un cambio de usuario no deje avisos de PAGOS.
            if(Notification.permission === 'granted'){
                const existente = await registro.pushManager.getSubscription();
                if(existente){
                    try{
                        await fetch('/api/notificaciones/desuscribir',{
                            method:'POST',
                            credentials:'same-origin',
                            headers:{'Content-Type':'application/json'},
                            body:JSON.stringify({endpoint:existente.endpoint})
                        });
                    }catch(_){}
                }
            }
            console.log('ℹ️ GOOD COMPANY — usuario sin permiso PAGOS; no se activa Web Push.');
            return;
        }

        if(Notification.permission === 'granted'){
            await suscribirPushGoodCompany(registro);
        }

    }catch(error){
        console.error(
            '❌ ERROR INICIALIZANDO NOTIFICACIONES GOOD COMPANY:',
            error
        );
    }
}

async function suscribirPushGoodCompany(registro){

    try{
        const respuestaKey =
            await fetch(
                '/api/notificaciones/vapid-public-key',
                {
                    method:'GET',
                    cache:'no-store',
                    credentials:'same-origin'
                }
            );

        if(!respuestaKey.ok){
            const textoError =
                await respuestaKey.text().catch(()=>'');

            throw new Error(
                `VAPID HTTP ${respuestaKey.status}: ${textoError.slice(0,200)}`
            );
        }

        const datos =
            await respuestaKey.json();

        const publicKey =
            datos.publicKey;

        if(!publicKey){
            throw new Error(
                'Clave pública VAPID vacía.'
            );
        }

        let subscription =
            await registro.pushManager.getSubscription();

        if(!subscription){

            subscription =
                await registro.pushManager.subscribe({
                    userVisibleOnly:true,
                    applicationServerKey:
                        base64UrlToUint8Array(
                            publicKey
                        )
                });

        }

        const respuesta =
            await fetch(
                '/api/notificaciones/suscribir',
                {
                    method:'POST',
                    credentials:'same-origin',
                    headers:{
                        'Content-Type':
                            'application/json'
                    },
                    body:JSON.stringify({
                        subscription:
                            subscription.toJSON
                                ? subscription.toJSON()
                                : subscription
                    })
                }
            );

        if(!respuesta.ok){

            const error =
                await respuesta.json()
                    .catch(()=>({}));

            throw new Error(
                error.error ||
                `No se pudo guardar la suscripción. HTTP ${respuesta.status}`
            );

        }

        console.log(
            '🟢 GOOD COMPANY — WEB PUSH SUSCRIPTO.'
        );

        return subscription;

    }catch(error){

        console.error(
            '❌ GOOD COMPANY — ERROR SUSCRIBIENDO WEB PUSH:',
            error
        );

        return null;
    }
}

// Intento de registro inmediato.
// Esto no depende de DOMContentLoaded y permite que el SW
// quede instalado aunque la página todavía no haya terminado de cargar.
if(document.readyState === 'loading'){
    registrarServiceWorkerGoodCompany();
}else{
    registrarServiceWorkerGoodCompany();
}

function base64UrlToUint8Array(base64UrlData){
    const padding =
        '='.repeat(
            (4 - base64UrlData.length % 4) % 4
        );

    const base64 =
        (
            base64UrlData +
            padding
        )
        .replace(/-/g,'+')
        .replace(/_/g,'/');

    const rawData =
        atob(base64);

    return Uint8Array.from(
        [...rawData].map(
            char => char.charCodeAt(0)
        )
    );
}


// ======================================================
// GOOD COMPANY - APP.JS
// ======================================================
//
// WEB
//   ↓
// APP.JS
//   ↓
// NODE.JS
//   ↓
// GOOGLE SHEETS
//
// SIN SUPABASE
// SIN EXCEL
//
// ======================================================


document.addEventListener(
    'DOMContentLoaded',
    async () => {

        console.log(
            '🚀 GOOD COMPANY - APP INICIADA'
        );

        configurarEventos();

        // Registrar notificaciones sin bloquear el arranque de INDEX.
        inicializarNotificacionesWindows();

        await cargarTalleres();

    }
);


// ======================================================
// VARIABLES GLOBALES
// ======================================================

let coloresCache = [];

let articulosCache = [];

// Reserva seleccionada desde TAREAS para cargar en REGISTRAR SALIDA.
let reservaSeleccionada = null;


// ======================================================
// CONFIGURAR EVENTOS
// ======================================================

function configurarEventos() {

    // ==================================================
    // SELECTOR DE TALLER
    // ==================================================

    const selectTaller =
        document.getElementById(
            'select-taller'
        );


    if (selectTaller) {

        selectTaller.addEventListener(
            'change',
            async function () {

                const tallerId =
                    this.value;


                console.log(
                    '🏭 Taller seleccionado:',
                    tallerId
                );


                const seccion =
                    document.getElementById(
                        'seccion-operaciones'
                    );


                if (!tallerId) {

                    limpiarPendientes();

                    limpiarFormularioEgreso();
                    await cargarReservasProduccion('');


                    if (seccion) {

                        seccion.classList.add(
                            'hidden'
                        );

                    }

                    return;

                }


                if (seccion) {

                    seccion.classList.remove(
                        'hidden'
                    );

                }


                limpiarPendientes();


                await Promise.all([
                    cargarColores(),
                    cargarArticulos()
                ]);


                await cargarPendientes(
                    tallerId
                );

                await cargarReservasProduccion(tallerId);


                const articulo =
                    document.querySelector(
                        '.input-articulo'
                    );


                if (articulo) {

                    articulo.focus();

                }

            }
        );

    }


    // ==================================================
    // BOTÓN AGREGAR SALE
    // ==================================================

    const btnAgregar =
        document.getElementById(
            'btn-agregar-entrega'
        );


    if (btnAgregar) {

        btnAgregar.addEventListener(
            'click',
            async function (event) {

                event.preventDefault();

                await registrarEgreso();

            }
        );

    }


    // ==================================================
    // BOTÓN GUARDAR
    // ==================================================

    const btnGuardar =
        document.getElementById(
            'btn-guardar'
        );


    if (btnGuardar) {

        btnGuardar.addEventListener(
            'click',
            async function (event) {

                event.preventDefault();


                if (
                    typeof registrarMovimiento ===
                    'function'
                ) {

                    await registrarMovimiento();

                }

            }
        );

    }


    configurarEnter();

}


// ======================================================
// CARGAR TALLERES
// ======================================================

async function cargarTalleres() {

    const select =
        document.getElementById(
            'select-taller'
        );


    if (!select) {

        console.error(
            '❌ No existe #select-taller'
        );

        return;

    }


    try {

        select.innerHTML =
            `
            <option value="">
                -- Seleccionar taller --
            </option>
            `;


        console.log(
            '📡 Consultando /api/talleres...'
        );


        const respuesta =
            await fetch(
                '/api/talleres',
                {
                    method: 'GET',
                    cache: 'no-store'
                }
            );


        if (!respuesta.ok) {

            const texto =
                await respuesta.text();


            console.error(
                'Respuesta del servidor:',
                texto
            );


            throw new Error(
                'No se pudieron cargar los talleres.'
            );

        }


const talleres =
    await respuesta.json();


// ==================================================
// ORDEN ALFABÉTICO DE TALLERES
// ==================================================

talleres.sort(
    (a, b) =>
        String(a.nombre || '').localeCompare(
            String(b.nombre || ''),
            'es',
            {
                sensitivity: 'base'
            }
        )
);


console.log(
    '✅ Talleres recibidos:',
    talleres
);

        select.innerHTML =
            `
            <option value="">
                -- Seleccionar taller --
            </option>
            `;


        talleres.forEach(
            taller => {

                if (
                    taller.activo === false
                ) {

                    return;

                }


                const option =
                    document.createElement(
                        'option'
                    );


                option.value =
                    taller.id;


                option.textContent =
                    taller.nombre;


                select.appendChild(
                    option
                );

            }
        );


        console.log(
            `✅ ${talleres.length} talleres cargados`
        );


    } catch (error) {

        console.error(
            '❌ ERROR CARGANDO TALLERES:',
            error
        );


        select.innerHTML =
            `
            <option value="">
                ❌ Error cargando talleres
            </option>
            `;

    }

}


// ======================================================
// CARGAR ARTÍCULOS
// ======================================================

async function cargarArticulos() {

    try {

        const respuesta =
            await fetch(
                '/api/articulos',
                {
                    method: 'GET',
                    cache: 'no-store'
                }
            );


        if (!respuesta.ok) {

            throw new Error(
                'No se pudieron cargar los artículos.'
            );

        }


        const datos =
            await respuesta.json();


        articulosCache =
            Array.isArray(datos)
                ? datos
                : [];


        console.log(
            '📦 Artículos cargados:',
            articulosCache.length
        );


    } catch (error) {

        console.error(
            '❌ ERROR CARGANDO ARTÍCULOS:',
            error
        );


        articulosCache = [];

    }

}


// ======================================================
// CARGAR COLORES
// ======================================================

async function cargarColores() {

    try {

        const respuesta =
            await fetch(
                '/api/colores',
                {
                    method: 'GET',
                    cache: 'no-store'
                }
            );


        if (!respuesta.ok) {

            throw new Error(
                'No se pudieron cargar los colores.'
            );

        }


        const datos =
            await respuesta.json();


        coloresCache =
            Array.isArray(datos)
                ? datos
                : [];


        console.log(
            '🎨 Colores cargados:',
            coloresCache.length
        );


        actualizarSelectoresColor();


    } catch (error) {

        console.error(
            '❌ ERROR CARGANDO COLORES:',
            error
        );

    }

}


// ======================================================
// ACTUALIZAR SELECTORES DE COLOR
// ======================================================

function actualizarSelectoresColor() {

    const selects =
        document.querySelectorAll(
            '.select-color'
        );


    selects.forEach(
        select => {

            llenarSelectColor(
                select
            );

        }
    );

}


// ======================================================
// LLENAR SELECT COLOR
// ======================================================

function llenarSelectColor(
    select
) {

    const valorActual =
        select.value;


    select.innerHTML =
        `
        <option value="">
            -- Seleccionar color --
        </option>
        `;


    coloresCache
        .filter(
            color =>
                color.activo !== false
        )
        .forEach(
            color => {

                const option =
                    document.createElement(
                        'option'
                    );


                option.value =
                    color.nombre;


                option.textContent =
                    color.nombre;


                select.appendChild(
                    option
                );

            }
        );


    if (valorActual) {

        select.value =
            valorActual;

    }

}


// ======================================================
// CARGAR PENDIENTES
// ======================================================
//
// AHORA CARGA:
//
// PENDIENTES
// REPARACIONES
// MUESTRAS
//
// EN TRES TABLAS SEPARADAS.
//

async function cargarPendientes(
    tallerId
) {

    const tablaPendientes =
        document.getElementById(
            'tabla-pendientes'
        );


    const tablaReparaciones =
        document.getElementById(
            'tabla-reparaciones'
        );


    const tablaMuestras =
        document.getElementById(
            'tabla-muestras'
        );


    if (
        !tablaPendientes ||
        !tablaReparaciones ||
        !tablaMuestras
    ) {

        console.error(
            '❌ No se encontraron las tres tablas de mercadería.'
        );

        return;

    }


    // ==================================================
    // MENSAJE DE CARGA
    // ==================================================

    const mensajeCarga =
        `
        <tr>

            <td
                colspan="5"
                class="p-5 text-center text-slate-400 font-bold"
            >
                ⏳ Cargando...
            </td>

        </tr>
        `;


    tablaPendientes.innerHTML =
        mensajeCarga;


    tablaReparaciones.innerHTML =
        mensajeCarga;


    tablaMuestras.innerHTML =
        mensajeCarga;


    try {

        const respuesta =
            await fetch(
                `/api/talleres/${encodeURIComponent(tallerId)}/pendientes`,
                {
                    method: 'GET',
                    cache: 'no-store'
                }
            );


        if (!respuesta.ok) {

            let mensaje =
                'No se pudieron cargar los pendientes.';


            try {

                const error =
                    await respuesta.json();


                mensaje =
                    error.error ||
                    mensaje;


            } catch (_) {}


            throw new Error(
                mensaje
            );

        }


        const resultado =
            await respuesta.json();


        const pendientes =
            Array.isArray(
                resultado.pendientes
            )
                ? resultado.pendientes
                : [];


        const reparaciones =
            Array.isArray(
                resultado.reparaciones
            )
                ? resultado.reparaciones
                : [];


        const muestras =
            Array.isArray(
                resultado.muestras
            )
                ? resultado.muestras
                : [];


        console.log(
            '📦 PENDIENTES:',
            pendientes
        );


        console.log(
            '🔧 REPARACIONES:',
            reparaciones
        );


        console.log(
            '🏷️ MUESTRAS:',
            muestras
        );


        // ==================================================
        // SUMAR CANTIDADES
        // ==================================================

        const totalPendientes =
            sumarCantidades(
                pendientes
            );


        const totalReparaciones =
            sumarCantidades(
                reparaciones
            );


        const totalMuestras =
            sumarCantidades(
                muestras
            );


        // ==================================================
        // MOSTRAR TOTALES
        // ==================================================

        const elementoPendientes =
            document.getElementById(
                'total-pendientes'
            );


        const elementoReparaciones =
            document.getElementById(
                'total-reparaciones'
            );


        const elementoMuestras =
            document.getElementById(
                'total-muestras'
            );


        if (elementoPendientes) {

            elementoPendientes.textContent =
                totalPendientes;

        }


        if (elementoReparaciones) {

            elementoReparaciones.textContent =
                totalReparaciones;

        }


        if (elementoMuestras) {

            elementoMuestras.textContent =
                totalMuestras;

        }


        // ==================================================
        // RENDERIZAR CADA TABLA
        // ==================================================

        renderizarTablaMercaderia(
            tablaPendientes,
            pendientes,
            false,
            'Sin pendientes'
        );


        renderizarTablaMercaderia(
            tablaReparaciones,
            reparaciones,
            true,
            'Sin reparaciones'
        );


        renderizarTablaMercaderia(
            tablaMuestras,
            muestras,
            false,
            'Sin muestras'
        );


    } catch (error) {

        console.error(
            '❌ ERROR CARGANDO PENDIENTES:',
            error
        );


        const mensajeError =
            `
            <tr>

                <td
                    colspan="5"
                    class="p-5 text-center text-red-400 font-bold"
                >
                    ❌ ${escapeHtml(
                        error.message
                    )}
                </td>

            </tr>
            `;


        tablaPendientes.innerHTML =
            mensajeError;


        tablaReparaciones.innerHTML =
            mensajeError;


        tablaMuestras.innerHTML =
            mensajeError;

    }

}


// ======================================================
// SUMAR CANTIDADES
// ======================================================

function sumarCantidades(
    lista
) {

    if (
        !Array.isArray(
            lista
        )
    ) {

        return 0;

    }


    return lista.reduce(
        (
            total,
            item
        ) => {

            return (
                total +
                (
                    Number(
                        item?.cantidad_pendiente
                    ) || 0
                )
            );

        },
        0
    );

}


// ======================================================
// RENDERIZAR TABLA MERCADERÍA
// ======================================================

function renderizarTablaMercaderia(
    tabla,
    lista,
    esReparacion,
    mensajeVacio
) {

    tabla.innerHTML =
        '';


    // ==================================================
    // SIN DATOS
    // ==================================================

    if (
        !Array.isArray(lista) ||
        lista.length === 0
    ) {

        tabla.innerHTML =
            `
            <tr>

                <td
                    colspan="5"
                    class="p-5 text-center text-slate-500 font-bold"
                >
                    ${mensajeVacio}
                </td>

            </tr>
            `;

        return;

    }


    // ==================================================
    // DATOS
    // ==================================================

    lista.forEach(
        item => {

            const codigoVisible =
                obtenerCodigoArticulo(
                    item
                );


            const fechaSalida =
                formatearFecha(
                    item.fecha_salida
                );


            const tr =
                document.createElement(
                    'tr'
                );


            tr.className =
                'border-b border-slate-700 hover:bg-slate-800 transition';


            tr.innerHTML =
                `
                <td
                    class="px-2 py-2 text-left font-bold text-slate-100"
                >
                    ${escapeHtml(
                        codigoVisible
                    )}
                </td>


                <td
                    class="px-2 py-2 text-center font-black text-white"
                >
                    ${escapeHtml(
                        item.cantidad_pendiente
                    )}
                </td>


                <td
                    class="px-2 py-2 text-left font-semibold text-slate-300 uppercase"
                >
                    ${escapeHtml(
                        item.color
                    )}
                </td>


                <td
                    class="px-2 py-2 text-center font-medium text-slate-400"
                >
                    ${escapeHtml(
                        fechaSalida
                    )}
                </td>


                <td
                    class="px-2 py-2 text-center"
                >

                    <button
                        type="button"
                        class="btn-ingresar"
                    >
                        📥 INGRESAR
                    </button>

                </td>
                `;


            const boton =
                tr.querySelector(
                    '.btn-ingresar'
                );


            if (boton) {

                boton.addEventListener(
                    'click',
                    async () => {

                        await ingresarPendiente(
                            item,
                            esReparacion
                        );

                    }
                );

            }


            tabla.appendChild(
                tr
            );

        }
    );

}


// ======================================================
// OBTENER CÓDIGO DEL ARTÍCULO
// ======================================================

function obtenerCodigoArticulo(
    item
) {

    const codigoDirecto =
        item?.codigo ||
        item?.articulo_codigo;


    if (
        codigoDirecto !== undefined &&
        codigoDirecto !== null &&
        String(
            codigoDirecto
        ).trim() !== ''
    ) {

        return String(
            codigoDirecto
        ).trim();

    }


    const encontrado =
        articulosCache.find(
            articulo =>
                String(
                    articulo.id
                ) ===
                String(
                    item?.articulo_id
                )
        );


    if (encontrado) {

        return (
            encontrado.codigo ||
            encontrado.id ||
            ''
        );

    }


    return '';

}


// ======================================================
// INGRESAR MERCADERÍA PENDIENTE
// ======================================================

async function ingresarPendiente(
    pendiente,
    esReparacion
) {

    try {

        if (!pendiente) {

            return;

        }


        const codigo =
            obtenerCodigoArticulo(
                pendiente
            );


        const cantidadPendiente =
            Number(
                pendiente.cantidad_pendiente
            ) || 0;


        const color =
            String(
                pendiente.color ||
                ''
            )
            .trim()
            .toUpperCase();


        const fecha =
            formatearFecha(
                pendiente.fecha_salida
            );


        if (
            cantidadPendiente <= 0
        ) {

            alert(
                '❌ No queda cantidad pendiente.'
            );

            return;

        }


        // ==================================================
        // PREGUNTAR CANTIDAD
        // ==================================================

        let cantidad;

        // MUESTRA: siempre es 1 unidad. No se pregunta cantidad.
        if (
            color === 'MUESTRA'
        ) {

            cantidad = 1;

        } else {

            // PENDIENTE NORMAL o REPARACIÓN:
            // se pregunta cuántas unidades ingresaron.
            const cantidadInput =
                prompt(
                    `ARTÍCULO: ${codigo}\n` +
                    `COLOR: ${color}\n` +
                    `SALIDA: ${fecha}\n\n` +
                    `PENDIENTE: ${cantidadPendiente}\n\n` +
                    `¿CUÁNTAS UNIDADES TRAJO?`,
                    cantidadPendiente
                );

            if (
                cantidadInput === null
            ) {
                return;
            }

            cantidad = Number(cantidadInput);
        }


        if (
            !Number.isInteger(
                cantidad
            ) ||
            cantidad <= 0 ||
            cantidad >
                cantidadPendiente
        ) {

            alert(
                '❌ Cantidad inválida.'
            );

            return;

        }


        // ==================================================
        // CONFIRMAR NORMAL / REPARACIÓN
        // ==================================================

        let esReparacionFinal =
            Boolean(
                esReparacion
            );

        let esSinArmarFinal = false;


        if (
            !esReparacion &&
            color !== 'MUESTRA'
        ) {

            const esNormal =
                confirm(
                    `ARTÍCULO ${codigo}\n\n` +
                    `¿Las ${cantidad} unidades son NORMALES?\n\n` +
                    `ACEPTAR = NORMAL\n` +
                    `CANCELAR = SIN ARMAR`
                );

            // En pendientes normales:
            // ACEPTAR = NORMAL
            // CANCELAR = SIN ARMAR
            esReparacionFinal = false;
            esSinArmarFinal = !esNormal;
        }


        // ==================================================
        // TALLER
        // ==================================================

        const tallerSelect =
            document.getElementById(
                'select-taller'
            );


        const tallerId =
            tallerSelect?.value;


        if (!tallerId) {

            throw new Error(
                'No hay taller seleccionado.'
            );

        }


        // ==================================================
        // BOTONES
        // ==================================================

        const botones =
            document.querySelectorAll(
                '.btn-ingresar'
            );


        botones.forEach(
            boton => {

                boton.disabled =
                    true;

            }
        );


        // ==================================================
        // ENTRADA
        // ==================================================

        const respuesta =
            await fetch(
                `/api/talleres/${encodeURIComponent(tallerId)}/entradas`,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body:
                        JSON.stringify({

                            articulo:
                                codigo,

                            cantidad:
                                cantidad,

                            color:
                                color,

                            reparacion:
                                esReparacionFinal
                                    ? 'SI'
                                    : 'NO',

                            sin_armar:
                                esSinArmarFinal
                                    ? 'SI'
                                    : 'NO',

                            muestra:
                                color ===
                                'MUESTRA'
                                    ? 'SI'
                                    : 'NO'

                        })
                }
            );


        let resultado =
            {};


        try {

            resultado =
                await respuesta.json();

        } catch (_) {}


        if (
            !respuesta.ok
        ) {

            throw new Error(
                resultado.error ||
                'No se pudo registrar el ingreso.'
            );

        }


        console.log(
            '✅ INGRESO REGISTRADO:',
            resultado
        );


        mostrarToast(
            '✅ INGRESO REGISTRADO CORRECTAMENTE',
            2000
        );


        await cargarPendientes(
            tallerId
        );


    } catch (error) {

        console.error(
            '❌ ERROR AL INGRESAR PENDIENTE:',
            error
        );


        alert(
            '❌ ERROR:\n\n' +
            error.message
        );


    } finally {

        const botones =
            document.querySelectorAll(
                '.btn-ingresar'
            );


        botones.forEach(
            boton => {

                boton.disabled =
                    false;

            }
        );

    }

}


// ======================================================
// RESERVAS DE PRODUCCIÓN — TAREAS
// ======================================================

let tareasReservadasCache=[];
let tareasReservadasPromesa=null;

async function cargarTareasReservadas(){
    if(tareasReservadasPromesa)return tareasReservadasPromesa;

    tareasReservadasPromesa=(async()=>{
        try{
            const respuesta=await fetch('/api/tareas',{cache:'no-store'});
            const datos=await respuesta.json();

            if(!respuesta.ok){
                throw new Error(datos.error||'No se pudieron cargar las tareas.');
            }

            tareasReservadasCache=Array.isArray(datos.tareas)
                ? datos.tareas
                : [];

            return tareasReservadasCache;
        }catch(error){
            console.error('❌ ERROR LEYENDO TAREAS:',error);
            tareasReservadasCache=[];
            return [];
        }finally{
            tareasReservadasPromesa=null;
        }
    })();

    return tareasReservadasPromesa;
}

function fechaReservaMostrar(valor) {

    const s = String(valor || '').trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y,m,d] = s.split('-');
        return `${d}/${m}/${y}`;
    }

    return formatearFecha(s);
}

function obtenerNombreTallerSeleccionado() {

    const select = document.getElementById('select-taller');

    return (
        select?.options[select.selectedIndex]?.text || ''
    ).trim();
}

function cantidadColoresReserva(tarea) {

    if (
        Array.isArray(tarea?.colores) &&
        tarea.colores.length
    ) {
        return tarea.colores
            .map(x => ({
                color: String(x?.color || '').trim().toUpperCase(),
                cantidad: Number(x?.cantidad) || 0
            }))
            .filter(x => x.color && x.cantidad > 0);
    }

    const color = String(tarea?.color || '').trim().toUpperCase();
    const cantidad = Number(tarea?.cantidad) || 0;

    return color && cantidad > 0
        ? [{ color, cantidad }]
        : [];
}

async function cargarReservasProduccion(tallerId) {

    const contenedor = document.getElementById('seccion-reservas-produccion');
    const lista = document.getElementById('lista-reservas-produccion');
    const contador = document.getElementById('reservas-contador');
    const subtitulo = document.getElementById('reservas-subtitulo');

    if (!contenedor || !lista) return;

    reservaSeleccionada = null;

    if (!tallerId) {
        contenedor.classList.add('hidden');
        lista.innerHTML = '';
        if (contador) contador.textContent = '0';
        return;
    }

    const taller = obtenerNombreTallerSeleccionado();
    if (subtitulo) subtitulo.textContent = taller || 'Taller seleccionado';

    const reservas = [];
    const tareas = await cargarTareasReservadas();

    tareas.forEach(tarea => {

        if (!tarea || tarea.origen === 'HISTORIAL') return;

        // IMPORTANTE: una producción PENDIENTE todavía no existe para INDEX.
        // Solo una tarea COMPLETA puede generar reservas visibles aquí.
        if (String(tarea.estado || '').trim().toUpperCase() !== 'COMPLETO') return;

        // RESERVAS y DISPONIBLES representan la TAREA, no el desglose interno
        // de TAREAS_COLORES. Por eso cada artículo genera UNA sola fila y
        // conserva: cantidad de la tarea + color base de la tarea + fecha.
        const cantidadTarea = Number(tarea.cantidad) || 0;
        const colorBase = String(tarea.color || '').trim().toUpperCase();
        const articulos = Array.isArray(tarea.articulos) ? tarea.articulos : [];

        articulos.forEach((articulo, indiceArticulo) => {

            if (!articulo || articulo.fechaSalida) return;

            if (
                String(articulo.taller || '').trim().toUpperCase() !==
                String(taller || '').trim().toUpperCase()
            ) return;

            reservas.push({
                tareaId: String(tarea.id),
                idArticuloTarea: String(articulo.id || ''),
                indiceArticulo,
                articulo: String(articulo.articulo || '').trim(),
                cantidad: cantidadTarea,
                color: colorBase,
                fechaProduccion: tarea.fecha || '',
                fechaSalida: ''
            });
        });
    });

    reservas.sort((a,b) => {
        const fa = String(a.fechaProduccion || '');
        const fb = String(b.fechaProduccion || '');
        return fa.localeCompare(fb) || a.articulo.localeCompare(b.articulo, 'es', {numeric:true});
    });

    contador.textContent = String(reservas.length);

    if (!reservas.length) {
        contenedor.classList.remove('hidden');
        lista.innerHTML = `
            <div class="px-4 py-4 text-center text-xs text-slate-500 font-bold">
                No hay reservas pendientes para ${escapeHtml(taller)}.
            </div>
        `;
        return;
    }

    contenedor.classList.remove('hidden');

    lista.innerHTML = reservas.map((r, i) => `
        <div class="reserva-row">
            <div class="reserva-art">${escapeHtml(r.articulo)}</div>
            <div class="text-center font-black text-white">${r.cantidad}</div>
            <div class="font-bold text-slate-200">${escapeHtml(r.color)}</div>
            <div class="reserva-fecha">${escapeHtml(fechaReservaMostrar(r.fechaProduccion))}</div>
            <button
                type="button"
                class="reserva-add"
                data-reserva-index="${i}"
            >
                ➕ AGREGAR
            </button>
        </div>
    `).join('');

    lista.querySelectorAll('.reserva-add').forEach((boton, i) => {
        boton.addEventListener('click', () => agregarReservaAFormulario(reservas[i]));
    });
}

function agregarReservaAFormulario(reserva) {

    if (!reserva) return;

    const articulo = document.querySelector('.input-articulo');
    const cantidad = document.querySelector('.input-cantidad');
    const color = document.querySelector('.select-color');
    const reparacion = document.querySelector('.select-reparacion');

    if (!articulo || !cantidad || !color || !reparacion) {
        alert('❌ No encontré el formulario REGISTRAR SALIDA.');
        return;
    }

    articulo.value = reserva.articulo;
    cantidad.value = String(reserva.cantidad);
    color.value = reserva.color;
    reparacion.value = 'NO';

    reservaSeleccionada = { ...reserva };

    document.getElementById('form-egreso')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
    });

    articulo.focus();

    console.log('📦 RESERVA CARGADA EN EGRESO:', reservaSeleccionada);
}

async function marcarReservaComoEntregada(reserva, fechaSalida, movimientoId, taller){
    if(!reserva||!reserva.idArticuloTarea)return false;

    try{
        const respuesta=await fetch(
            `/api/tareas/articulos/${encodeURIComponent(reserva.idArticuloTarea)}`,
            {
                method:'PUT',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({
                    // Al retirar una reserva o un disponible,
                    // guardamos también el TALLER que realizó la salida.
                    taller:String(taller||'').trim().toUpperCase(),
                    fechaSalida,
                    movimientoId:String(movimientoId||'')
                })
            }
        );

        const data=await respuesta.json().catch(()=>({}));
        if(!respuesta.ok){
            throw new Error(data.error||'No se pudo actualizar el artículo de TAREAS.');
        }

        tareasReservadasCache=[];
        tareasReservadasPromesa=null;
        return true;

    }catch(error){
        console.error('❌ ERROR ACTUALIZANDO TAREA ARTÍCULO:',error);
        return false;
    }
}

function fechaHoyTareas() {

    const ahora = new Date();

    return `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,'0')}-${String(ahora.getDate()).padStart(2,'0')}`;
}

// ======================================================
// MODAL CONFIRMAR SALIDA
// ======================================================

function mostrarConfirmacionSalida(
    nombreTaller,
    codigo,
    cantidad,
    color,
    reparacion
) {
    return new Promise(resolve => {

        const anterior = document.getElementById('gc-modal-salida');
        if (anterior) anterior.remove();

        const overlay = document.createElement('div');
        overlay.id = 'gc-modal-salida';
        overlay.className = 'gc-salida-overlay';

        const LOGO =
            'https://raw.githubusercontent.com/serpereyra1981-GC/LOGOS/2a857363c00ab37e7fe8d1fb265a6c0681251949/LOGO%20TRANSPARENTE%20BLANCO.png';

        function esc(v) {
            return String(v ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        overlay.innerHTML = `
            <div class="gc-salida-modal" role="dialog" aria-modal="true" aria-labelledby="gc-salida-titulo">

                <div class="gc-salida-brand">
                    <img src="${LOGO}" alt="GOOD COMPANY">
                    <button type="button" class="gc-salida-close" id="gc-salida-cerrar" aria-label="Cerrar">×</button>
                </div>

                <div class="gc-salida-head">
                    <div class="gc-salida-head-icon">⇥</div>
                    <div>
                        <div class="gc-salida-title" id="gc-salida-titulo">REGISTRAR SALIDA</div>
                        <div class="gc-salida-subtitle">Confirmá los datos de la salida antes de registrar.</div>
                    </div>
                </div>

                <div class="gc-salida-body">

                    <div class="gc-salida-taller">
                        <span class="gc-salida-taller-icon">♟</span>
                        <span class="gc-salida-label">TALLER:</span>
                        <span class="gc-salida-value">${esc(nombreTaller)}</span>
                    </div>

                    <div class="gc-salida-info">
                        <div class="gc-salida-row">
                            <span class="gc-salida-row-icon">◇</span>
                            <span class="gc-salida-row-label">ARTÍCULO</span>
                            <strong>${esc(codigo)}</strong>
                        </div>
                        <div class="gc-salida-row">
                            <span class="gc-salida-row-icon">⊕</span>
                            <span class="gc-salida-row-label">CANTIDAD</span>
                            <strong>${esc(cantidad)}</strong>
                        </div>
                        <div class="gc-salida-row">
                            <span class="gc-salida-row-icon">♣</span>
                            <span class="gc-salida-row-label">COLOR</span>
                            <strong>${esc(color)}</strong>
                        </div>
                        <div class="gc-salida-row">
                            <span class="gc-salida-row-icon">⚒</span>
                            <span class="gc-salida-row-label">REPARACIÓN</span>
                            <strong>${reparacion ? 'SI' : 'NO'}</strong>
                        </div>
                    </div>

                    <div class="gc-salida-question">
                        <span class="gc-salida-question-icon">?</span>
                        <span>¿Confirmar la salida?</span>
                    </div>

                </div>

                <div class="gc-salida-actions">
                    <button type="button" class="gc-salida-btn gc-salida-cancel" id="gc-salida-cancelar">
                        <span>×</span> CANCELAR
                    </button>
                    <button type="button" class="gc-salida-btn gc-salida-confirm" id="gc-salida-confirmar">
                        <span>✓</span> CONFIRMAR SALIDA
                    </button>
                </div>

                <div class="gc-salida-tip">
                    ⓘ &nbsp; Atajo de teclado: &nbsp;
                    <b>Enter</b> = Confirmar &nbsp; | &nbsp; <b>Esc</b> = Cancelar
                </div>

            </div>
        `;

        document.body.appendChild(overlay);

        const confirmar = overlay.querySelector('#gc-salida-confirmar');
        const cancelar = overlay.querySelector('#gc-salida-cancelar');
        const cerrar = overlay.querySelector('#gc-salida-cerrar');
        let terminado = false;

        function finalizar(valor) {
            if (terminado) return;
            terminado = true;
            document.removeEventListener('keydown', manejarTeclado, true);
            overlay.remove();
            resolve(valor);
        }

        function manejarTeclado(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                finalizar(false);
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                finalizar(true);
            }
        }

        confirmar?.addEventListener('click', () => finalizar(true));
        cancelar?.addEventListener('click', () => finalizar(false));
        cerrar?.addEventListener('click', () => finalizar(false));

        document.addEventListener('keydown', manejarTeclado, true);

        requestAnimationFrame(() => {
            confirmar?.focus();
        });
    });
}

// ======================================================
// REGISTRAR EGRESO / SALE
// ======================================================

async function registrarEgreso() {

    console.log(
        '➕ AGREGAR - registrando SALE...'
    );


    // ==================================================
    // TALLER
    // ==================================================

    const tallerSelect =
        document.getElementById(
            'select-taller'
        );


    const tallerId =
        tallerSelect?.value;


    if (!tallerId) {

        alert(
            '❌ Primero seleccioná un taller.'
        );

        return;

    }


    // ==================================================
    // CAMPOS
    // ==================================================

    const articuloInput =
        document.querySelector(
            '.input-articulo'
        );


    const cantidadInput =
        document.querySelector(
            '.input-cantidad'
        );


    const colorSelect =
        document.querySelector(
            '.select-color'
        );


    const reparacionSelect =
        document.querySelector(
            '.select-reparacion'
        );


    if (
        !articuloInput ||
        !cantidadInput ||
        !colorSelect ||
        !reparacionSelect
    ) {

        alert(
            '❌ No se encontraron los campos de carga.'
        );

        return;

    }


    // ==================================================
    // DATOS
    // ==================================================

    const codigo =
        articuloInput.value
            .trim()
            .toUpperCase();


    const cantidadRaw =
        cantidadInput.value.trim();


    const cantidad =
        Number(
            cantidadRaw
        );


    const color =
        colorSelect.value
            .trim()
            .toUpperCase();


    const reparacion =
        reparacionSelect.value
            .trim()
            .toUpperCase() ===
        'SI';


    // ==================================================
    // VALIDACIONES
    // ==================================================

    if (!codigo) {

        alert(
            '⚠️ Ingresá el código del artículo.'
        );

        articuloInput.focus();

        return;

    }


    if (
        !cantidadRaw ||
        !Number.isInteger(
            cantidad
        ) ||
        cantidad <= 0
    ) {

        alert(
            '⚠️ Ingresá una cantidad válida mayor a 0.'
        );

        cantidadInput.focus();

        return;

    }


    if (!color) {

        alert(
            '❌ Seleccioná un color.'
        );

        colorSelect.focus();

        return;

    }


    if (
        reparacion &&
        color === 'MUESTRA'
    ) {

        alert(
            '❌ Un artículo no puede ser REPARACIÓN y MUESTRA al mismo tiempo.'
        );

        return;

    }


    // ==================================================
    // NOMBRE DEL TALLER
    // ==================================================

    const nombreTaller =
        tallerSelect
            .options[
                tallerSelect.selectedIndex
            ]?.text || '';


    // ==================================================
    // CONFIRMAR CON CARTEL GOOD COMPANY
    // ==================================================

    const confirmar =
        await mostrarConfirmacionSalida(
            nombreTaller,
            codigo,
            cantidad,
            color,
            reparacion
        );


    if (!confirmar) {

        return;

    }


    // ==================================================
    // BOTÓN
    // ==================================================

    const boton =
        document.getElementById(
            'btn-agregar-entrega'
        );


    if (boton) {

        boton.disabled =
            true;

        boton.textContent =
            '⏳ REGISTRANDO...';

    }


    try {

        // ==================================================
        // SALIDA
        // ==================================================

        const respuesta =
            await fetch(
                `/api/talleres/${encodeURIComponent(tallerId)}/salidas`,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body:
                        JSON.stringify({

                            articulo:
                                codigo,

                            cantidad:
                                cantidad,

                            color:
                                color,

                            reparacion:
                                reparacion
                                    ? 'SI'
                                    : 'NO',

                            sin_armar:
                                'NO',

                            muestra:
                                color ===
                                'MUESTRA'
                                    ? 'SI'
                                    : 'NO'

                        })
                }
            );


        let resultado =
            {};


        try {

            resultado =
                await respuesta.json();

        } catch (_) {}


        if (
            !respuesta.ok
        ) {

            throw new Error(
                resultado.error ||
                'No se pudo registrar la salida.'
            );

        }


        console.log(
            '✅ SALE REGISTRADA:',
            resultado
        );


        // Si la salida vino de una reserva, recién AHORA
        // se marca la fecha real de retiro en TAREAS.
        // La fecha de producción permanece intacta.
        if (
            reservaSeleccionada &&
            String(codigo).trim().toUpperCase() ===
            String(reservaSeleccionada.articulo).trim().toUpperCase() &&
            String(color).trim().toUpperCase() ===
            String(reservaSeleccionada.color).trim().toUpperCase() &&
            Number(cantidad) === Number(reservaSeleccionada.cantidad)
        ) {
            const actualizada = await marcarReservaComoEntregada(
                reservaSeleccionada,
                fechaHoyTareas(),
                resultado.id,
                nombreTaller
            );

            if (!actualizada) {
                console.warn('⚠️ La salida se registró, pero no pude actualizar la reserva en TAREAS.');
            }
        }

        // ==================================================
        // SALIDA AISLADA = GENERAR REMIS / BOLETA
        // ==================================================
        let numeroRemis = '';

        if (resultado.salidaAislada) {

            try {

                const respuestaRemis =
                    await fetch(
                        '/api/pagos/boleta-salida',
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json'
                            },

                            body:
                                JSON.stringify({
                                    id:
                                        String(
                                            resultado.id
                                        )
                                })
                        }
                    );

                const datosRemis =
                    await respuestaRemis.json();

                if (!respuestaRemis.ok) {

                    throw new Error(
                        datosRemis.error ||
                        'No se pudo generar el REMIS.'
                    );

                }

                numeroRemis =
                    String(
                        datosRemis.numeroBoleta ||
                        ''
                    );

                if (
                    datosRemis.agrupado
                ) {
                    console.log(
                        '🚚 SALIDA AGRUPADA EN REMIS EXISTENTE:',
                        numeroRemis
                    );
                }

            } catch (errorRemis) {

                console.error(
                    '❌ ERROR GENERANDO REMIS:',
                    errorRemis
                );

                mostrarCartelTemporal(
                    '⚠️ SALIDA REGISTRADA\nNO SE PUDO GENERAR EL REMIS',
                    'warning'
                );

                reservaSeleccionada = null;

                limpiarFormularioEgreso();

                await cargarPendientes(
                    tallerId
                );

                cargarReservasProduccion(
                    tallerId
                );

                return;

            }

        }

        reservaSeleccionada = null;

        if (resultado.salidaAislada) {

            mostrarCartelTemporal(
                `🚚 SALIDA AISLADA\nREMIS N° ${numeroRemis}`,
                'ok'
            );

        } else {

            mostrarCartelTemporal(
                '✅ MOVIMIENTO REGISTRADO CORRECTAMENTE',
                'ok'
            );

        }

        limpiarFormularioEgreso();


        await cargarPendientes(
            tallerId
        );

        await cargarReservasProduccion(
            tallerId
        );


    } catch (error) {

        console.error(
            '❌ ERROR REGISTRANDO SALE:',
            error
        );


        alert(
            '❌ ERROR:\n\n' +
            error.message
        );


    } finally {

        if (boton) {

            boton.disabled =
                false;

            boton.textContent =
                '➕ AGREGAR';

        }

    }

}


// ======================================================
// COMPATIBILIDAD
// ======================================================

async function registrarMovimiento() {

    return await registrarEgreso();

}


// ======================================================
// COMPATIBILIDAD
// ======================================================

async function enviarMovimiento(
    entregas,
    recepciones
) {

    try {

        const tallerSelect =
            document.getElementById(
                'select-taller'
            );


        const tallerId =
            tallerSelect?.value;


        if (!tallerId) {

            throw new Error(
                'No hay taller seleccionado.'
            );

        }


        // ==================================================
        // ENTRADAS
        // ==================================================

        if (
            Array.isArray(
                recepciones
            ) &&
            recepciones.length
        ) {

            for (
                const recepcion
                of recepciones
            ) {

                const codigo =
                    recepcion.articulo_codigo ||
                    recepcion.codigo ||
                    '';


                const respuesta =
                    await fetch(
                        `/api/talleres/${encodeURIComponent(tallerId)}/entradas`,
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json'
                            },

                            body:
                                JSON.stringify({

                                    articulo:
                                        codigo,

                                    cantidad:
                                        recepcion.cantidad,

                                    color:
                                        recepcion.color,

                                    reparacion:
                                        recepcion.reparacion
                                            ? 'SI'
                                            : 'NO',

                                    sin_armar:
                                        recepcion.cantidad_sin_armar >
                                        0
                                            ? 'SI'
                                            : 'NO',

                                    muestra:
                                        String(
                                            recepcion.color ||
                                            ''
                                        )
                                        .toUpperCase() ===
                                        'MUESTRA'
                                            ? 'SI'
                                            : 'NO'

                                })
                        }
                    );


                let resultado =
                    {};


                try {

                    resultado =
                        await respuesta.json();

                } catch (_) {}


                if (
                    !respuesta.ok
                ) {

                    throw new Error(
                        resultado.error ||
                        'No se pudo registrar la entrada.'
                    );

                }

            }

        }


        // ==================================================
        // SALIDAS
        // ==================================================

        if (
            Array.isArray(
                entregas
            ) &&
            entregas.length
        ) {

            for (
                const entrega
                of entregas
            ) {

                const codigo =
                    entrega.articulo_codigo ||
                    entrega.codigo ||
                    entrega.articulo ||
                    '';


                const respuesta =
                    await fetch(
                        `/api/talleres/${encodeURIComponent(tallerId)}/salidas`,
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json'
                            },

                            body:
                                JSON.stringify({

                                    articulo:
                                        codigo,

                                    cantidad:
                                        entrega.cantidad,

                                    color:
                                        entrega.color,

                                    reparacion:
                                        entrega.reparacion
                                            ? 'SI'
                                            : 'NO',

                                    sin_armar:
                                        'NO',

                                    muestra:
                                        String(
                                            entrega.color ||
                                            ''
                                        )
                                        .toUpperCase() ===
                                        'MUESTRA'
                                            ? 'SI'
                                            : 'NO'

                                })
                        }
                    );


                let resultado =
                    {};


                try {

                    resultado =
                        await respuesta.json();

                } catch (_) {}


                if (
                    !respuesta.ok
                ) {

                    throw new Error(
                        resultado.error ||
                        'No se pudo registrar la salida.'
                    );

                }

            }

        }


        console.log(
            '✅ MOVIMIENTO REGISTRADO'
        );


        return true;


    } catch (error) {

        console.error(
            '❌ ERROR ENVIANDO MOVIMIENTO:',
            error
        );


        alert(
            '❌ ERROR:\n\n' +
            error.message
        );


        return false;

    }

}


// ======================================================
// NAVEGACIÓN CON ENTER
// ======================================================

function configurarEnter() {

    const formulario =
        document.getElementById(
            'form-egreso'
        );


    if (!formulario) {

        console.warn(
            '⚠️ No existe #form-egreso'
        );

        return;

    }


    const campos =
        formulario.querySelectorAll(
            'input, select'
        );


    campos.forEach(
        campo => {

            campo.addEventListener(
                'keydown',
                async function (event) {

                    if (
                        event.key !==
                        'Enter'
                    ) {

                        return;

                    }


                    event.preventDefault();


                    if (
                        campo.classList.contains(
                            'select-reparacion'
                        )
                    ) {

                        await registrarEgreso();

                        return;

                    }


                    const camposActualizados =
                        Array.from(
                            formulario.querySelectorAll(
                                'input, select'
                            )
                        );


                    const posicion =
                        camposActualizados.indexOf(
                            campo
                        );


                    const siguiente =
                        camposActualizados[
                            posicion + 1
                        ];


                    if (siguiente) {

                        siguiente.focus();

                    }

                }
            );

        }
    );


    const boton =
        document.getElementById(
            'btn-agregar-entrega'
        );


    if (boton) {

        boton.addEventListener(
            'keydown',
            async function (event) {

                if (
                    event.key ===
                    'Enter'
                ) {

                    event.preventDefault();

                    await registrarEgreso();

                }

            }
        );

    }

}



// ======================================================
// CARTEL TEMPORAL DE OPERACIÓN (2 SEGUNDOS)
// ======================================================
function mostrarCartelTemporal(mensaje, tipo = 'ok') {

    let cartel = document.getElementById('gc-cartel-temporal');

    if (!cartel) {

        cartel = document.createElement('div');

        cartel.id = 'gc-cartel-temporal';

        cartel.style.position = 'fixed';
        cartel.style.left = '50%';
        cartel.style.top = '50%';
        cartel.style.transform = 'translate(-50%, -50%)';
        cartel.style.zIndex = '99999';
        cartel.style.minWidth = '280px';
        cartel.style.maxWidth = '90vw';
        cartel.style.padding = '18px 24px';
        cartel.style.borderRadius = '14px';
        cartel.style.boxShadow = '0 20px 60px rgba(0,0,0,.45)';
        cartel.style.textAlign = 'center';
        cartel.style.fontWeight = '900';
        cartel.style.fontSize = '16px';
        cartel.style.whiteSpace = 'pre-line';

        document.body.appendChild(cartel);

    }

    cartel.style.background =
        tipo === 'ok'
            ? '#166534'
            : tipo === 'warning'
                ? '#92400e'
                : '#991b1b';

    cartel.style.color = '#fff';

    cartel.textContent = mensaje;

    cartel.style.display = 'block';

    clearTimeout(window.gcCartelTimer);

    window.gcCartelTimer = setTimeout(
        () => {
            cartel.style.display = 'none';
        },
        2000
    );

}

// ======================================================
// LIMPIAR FORMULARIO
// ======================================================

function limpiarFormularioEgreso() {

    const articulo =
        document.querySelector(
            '.input-articulo'
        );


    const cantidad =
        document.querySelector(
            '.input-cantidad'
        );


    const color =
        document.querySelector(
            '.select-color'
        );


    const reparacion =
        document.querySelector(
            '.select-reparacion'
        );


    if (articulo) {

        articulo.value =
            '';

    }


    if (cantidad) {

        cantidad.value =
            '';

    }


    if (color) {

        color.value =
            '';

    }


    if (reparacion) {

        reparacion.value =
            'NO';

    }

    reservaSeleccionada = null;


    if (articulo) {

        setTimeout(
            () => {

                articulo.focus();

            },
            50
        );

    }

}


// ======================================================
// LIMPIAR LAS TRES TABLAS
// ======================================================

function limpiarPendientes() {

    const tablaPendientes =
        document.getElementById(
            'tabla-pendientes'
        );


    const tablaReparaciones =
        document.getElementById(
            'tabla-reparaciones'
        );


    const tablaMuestras =
        document.getElementById(
            'tabla-muestras'
        );


    if (tablaPendientes) {

        tablaPendientes.innerHTML =
            '';

    }


    if (tablaReparaciones) {

        tablaReparaciones.innerHTML =
            '';

    }


    if (tablaMuestras) {

        tablaMuestras.innerHTML =
            '';

    }


    const totalPendientes =
        document.getElementById(
            'total-pendientes'
        );


    const totalReparaciones =
        document.getElementById(
            'total-reparaciones'
        );


    const totalMuestras =
        document.getElementById(
            'total-muestras'
        );


    if (totalPendientes) {

        totalPendientes.textContent =
            '0';

    }


    if (totalReparaciones) {

        totalReparaciones.textContent =
            '0';

    }


    if (totalMuestras) {

        totalMuestras.textContent =
            '0';

    }

}


// ======================================================
// FORMATEAR FECHA
// ======================================================
//
// SIEMPRE:
//
// DD/MM/YYYY
//
// ======================================================

function formatearFecha(
    fecha
) {

    if (
        fecha === null ||
        fecha === undefined
    ) {

        return '-';

    }


    let valor =
        String(
            fecha
        ).trim();


    if (!valor) {

        return '-';

    }


    // ==================================================
    // DD/MM/YYYY
    // ==================================================

    let partes =
        valor.split('/');


    if (
        partes.length === 3
    ) {

        const dia =
            partes[0]
                .padStart(
                    2,
                    '0'
                );


        const mes =
            partes[1]
                .padStart(
                    2,
                    '0'
                );


        const anio =
            partes[2];


        if (
            /^\d{4}$/.test(
                anio
            )
        ) {

            return (
                `${dia}/${mes}/${anio}`
            );

        }

    }


    // ==================================================
    // YYYY-MM-DD
    // ==================================================

    if (
        /^\d{4}-\d{1,2}-\d{1,2}$/
            .test(
                valor
            )
    ) {

        partes =
            valor.split('-');


        return (
            `${partes[2].padStart(2, '0')}/` +
            `${partes[1].padStart(2, '0')}/` +
            `${partes[0]}`
        );

    }


    // ==================================================
    // ISO
    // ==================================================

    if (
        valor.includes('T')
    ) {

        const soloFecha =
            valor.split('T')[0];


        return formatearFecha(
            soloFecha
        );

    }


    // ==================================================
    // ÚLTIMO RECURSO
    // ==================================================

    const fechaObjeto =
        new Date(
            valor
        );


    if (
        !Number.isNaN(
            fechaObjeto.getTime()
        )
    ) {

        const dia =
            String(
                fechaObjeto.getDate()
            )
            .padStart(
                2,
                '0'
            );


        const mes =
            String(
                fechaObjeto.getMonth() + 1
            )
            .padStart(
                2,
                '0'
            );


        const anio =
            fechaObjeto.getFullYear();


        return (
            `${dia}/${mes}/${anio}`
        );

    }


    return valor;

}


// ======================================================
// NORMALIZAR TEXTO
// ======================================================

function normalizarTexto(
    valor
) {

    return String(
        valor || ''
    )
    .trim()
    .toUpperCase();

}


// ======================================================
// ESCAPAR HTML
// ======================================================

function escapeHtml(
    texto
) {

    return String(
        texto ?? ''
    )
    .replaceAll(
        '&',
        '&amp;'
    )
    .replaceAll(
        '<',
        '&lt;'
    )
    .replaceAll(
        '>',
        '&gt;'
    )
    .replaceAll(
        '"',
        '&quot;'
    )
    .replaceAll(
        "'",
        '&#039;'
    );

}


// ======================================================
// FIN APP.JS
// ======================================================

console.log(
    '🟢 GOOD COMPANY APP.JS CARGADO'
);


console.log(
    '📊 Base de datos: GOOGLE SHEETS'
);


console.log(
    '📅 Fecha: DD/MM/YYYY'
);


console.log(
    '🚫 Excel: DESACTIVADO'
);