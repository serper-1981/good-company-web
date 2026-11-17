// GOOD COMPANY — CONTROL VISUAL DE PERMISOS
(async function(){
    const mapa={
        '/':'INGRESOS_EGRESOS',
        '/index.html':'INGRESOS_EGRESOS',
        '/tareas.html':'TAREAS',
        '/produccion.html':'PRODUCCION',
        '/talleres.html':'TALLERES',
        '/pagos.html':'PAGOS',
        '/bd.html':'BD',
        '/stock-online.html':'STOCK_ONLINE'
    };

    try{
        const r=await fetch('/api/auth/me');
        if(!r.ok){
            if(location.pathname!=='/login.html'){
                location.href='/login.html?next='+encodeURIComponent(location.pathname);
            }
            return;
        }

        const data=await r.json();
        const permisos=data.usuario?.permisos||{};
        window.GC_USUARIO=data.usuario;

        // STOCK ONLINE: acceso individual, visible solo con permiso.
        if(permisos.STOCK_ONLINE && location.pathname!=='/stock-online.html' && !document.getElementById('gc-stock-nav')){
            const link=document.createElement('a');
            link.id='gc-stock-nav';
            link.href='/stock-online.html';
            link.textContent='📦 STOCK ONLINE';
            link.style.cssText='position:fixed;right:12px;bottom:53px;z-index:99990;background:#0f766e;color:white;text-decoration:none;border-radius:9px;padding:10px 12px;font:800 12px Arial,Helvetica,sans-serif;box-shadow:0 4px 14px #0005';
            document.body.appendChild(link);
        }

        // ------------------------------------------------------------
        // CONTROL DE SESIÓN
        // Un solo control común, abajo a la izquierda.
        // Elimina controles antiguos duplicados, pero NUNCA toca el
        // botón de salida propio de BD (#btn-salir).
        // ------------------------------------------------------------
        document.querySelectorAll('body *').forEach(el=>{
            if(el.id==='btn-salir') return;

            const txt=(el.textContent||'').trim();
            const pos=getComputedStyle(el).position;

            if(
                pos==='fixed' &&
                txt.includes('SALIR') &&
                txt.includes(data.usuario?.usuario || '')
            ){
                el.remove();
            }
        });

        if(!document.getElementById('gc-session-box')){
            const caja=document.createElement('div');
            caja.id='gc-session-box';
            caja.style.cssText=
                'position:fixed;left:12px;bottom:12px;z-index:99999;'+
                'display:flex;align-items:center;gap:8px;'+
                'padding:6px 8px;border:1px solid #334155;'+
                'border-radius:9px;background:rgba(15,23,42,.97);'+
                'box-shadow:0 6px 18px rgba(0,0,0,.35);'+
                'font:800 12px Arial,Helvetica,sans-serif;color:#e2e8f0;';

            const nombre=document.createElement('span');
            nombre.textContent='👤 '+(
                data.usuario.usuario ||
                data.usuario.nombre ||
                'USUARIO'
            );

            const salir=document.createElement('button');
            salir.type='button';
            salir.textContent='🚪 SALIR';
            salir.style.cssText=
                'border:0;border-radius:7px;padding:6px 9px;'+
                'background:#991b1b;color:#fff;cursor:pointer;'+
                'font:900 11px Arial,Helvetica,sans-serif;';

            salir.addEventListener('click',async()=>{
                if(!confirm('¿Querés cerrar la sesión y cambiar de usuario?')) return;

                try{
                    await fetch('/api/auth/logout',{
                        method:'POST',
                        credentials:'same-origin'
                    });
                }catch(e){}

                location.href='/login.html';
            });

            caja.appendChild(nombre);
            caja.appendChild(salir);
            document.body.appendChild(caja);
        }

        // ------------------------------------------------------------
        // ADMINISTRAR USUARIOS — SOLO SUPERADMIN
        // ------------------------------------------------------------
        if(
            data.usuario?.rol==='SUPERADMIN' &&
            location.pathname!=='/admin-usuarios.html' &&
            !document.getElementById('gc-admin-users-box')
        ){
            const cajaAdmin=document.createElement('div');
            cajaAdmin.id='gc-admin-users-box';
            cajaAdmin.style.cssText=
                'position:fixed;right:12px;bottom:12px;z-index:99999;';

            const botonAdmin=document.createElement('button');
            botonAdmin.type='button';
            botonAdmin.textContent='⚙️ USUARIOS';
            botonAdmin.style.cssText=
                'border:0;border-radius:7px;padding:7px 10px;'+
                'background:#334155;color:#fff;cursor:pointer;'+
                'font:900 11px Arial,Helvetica,sans-serif;'+
                'box-shadow:0 6px 18px rgba(0,0,0,.35);';

            botonAdmin.onclick=()=>{
                location.href='/admin-usuarios.html';
            };

            cajaAdmin.appendChild(botonAdmin);
            document.body.appendChild(cajaAdmin);
        }


        // ------------------------------------------------------------
        // AVISO GLOBAL DE NUEVOS TALLERES PENDIENTES
        // SOLO usuarios con permiso BD reciben este aviso.
        // Al hacer clic, siempre abre PAGOS.
        // ------------------------------------------------------------
        if(permisos.BD && window.EventSource){

            // Pedimos el permiso de notificaciones al iniciar la app,
            // en lugar de esperar a que llegue el primer aviso.
            // Así el usuario con permiso BD no pierde el primer cartel.
            if('Notification' in window && Notification.permission==='default'){
                try{
                    Notification.requestPermission().catch(()=>{});
                }catch(e){}
            }

            const eventosPagos = new EventSource('/api/pagos/eventos');

            eventosPagos.addEventListener('pagos', event => {
                try{
                    const aviso = JSON.parse(event.data);
                    const nuevos = Array.isArray(aviso.nuevosTalleres)
                        ? aviso.nuevosTalleres
                        : [];

                    if(!nuevos.length || !('Notification' in window)) return;

                    const mostrar = () => {
                        const nombres = nuevos.join(', ');
                        const titulo = nuevos.length === 1
                            ? '💰 NUEVO TALLER PENDIENTE'
                            : '💰 NUEVOS TALLERES PENDIENTES';
                        const cuerpo = nuevos.length === 1
                            ? `${nombres} tiene un nuevo ingreso pendiente de pago.`
                            : `${nombres} tienen nuevos ingresos pendientes de pago.`;

                        try{
                            const notificacion = new Notification(titulo, {
                                body:cuerpo,
                                tag:'gc-nuevo-taller-pago',
                                renotify:true,
                                requireInteraction:true
                            });

                            notificacion.onclick = () => {
                                window.focus();
                                window.location.href='/pagos.html';
                                notificacion.close();
                            };
                        }catch(error){
                            console.warn('⚠️ No se pudo mostrar la notificación:',error);
                        }
                    };

                    if(Notification.permission==='granted'){
                        mostrar();
                    }else if(Notification.permission==='default'){
                        Notification.requestPermission()
                            .then(permiso=>{
                                if(permiso==='granted') mostrar();
                            })
                            .catch(()=>{});
                    }
                }catch(error){
                    console.warn('⚠️ AVISO PAGOS:',error);
                }
            });
        }

        document.querySelectorAll('a[href],button[onclick]').forEach(el=>{
            const href=el.getAttribute('href')||'';
            const onclick=el.getAttribute('onclick')||'';
            let ruta=href;
            const m=onclick.match(/(?:location\\.href|window\\.location\\.href)\\s*=\\s*['"]([^'"]+)/);
            if(m)ruta=m[1];
            const permiso=mapa[ruta];
            if(permiso && !permisos[permiso])el.style.display='none';
        });
    }catch(error){
        console.error('❌ AUTH UI:',error);
    }
})();
