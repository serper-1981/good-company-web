// ============================================================
// GOOD COMPANY — SERVICE WORKER
// Notificaciones Windows / Web Push
// ============================================================

const CACHE_VERSION = 'gc-push-v1';

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        self.clients.claim()
    );
});

self.addEventListener('push', event => {

    let datos = {};

    try{
        datos =
            event.data
                ? event.data.json()
                : {};
    }catch(_){
        datos = {
            title: 'GOOD COMPANY',
            body: event.data
                ? event.data.text()
                : ''
        };
    }

    const title =
        String(
            datos.title ||
            'GOOD COMPANY'
        );

    const options = {
        body:
            String(
                datos.body ||
                ''
            ),

        icon:
            datos.icon ||
            '/icon-good-company.svg',

        badge:
            datos.badge ||
            '/icon-good-company.svg',

        tag:
            String(
                datos.tag ||
                'good-company'
            ),

        renotify:
            true,

        requireInteraction:
            false,

        data: {
            url:
                datos.url ||
                '/pagos.html'
        }
    };

    event.waitUntil(
        self.registration.showNotification(
            title,
            options
        )
    );
});

self.addEventListener('notificationclick', event => {

    event.notification.close();

    const destino =
        event.notification?.data?.url ||
        '/pagos.html';

    event.waitUntil(
        clients.matchAll({
            type:'window',
            includeUncontrolled:true
        }).then(lista => {

            for(const cliente of lista){

                if(
                    'focus' in cliente &&
                    cliente.url.includes(
                        new URL(
                            destino,
                            self.location.origin
                        ).pathname
                    )
                ){
                    return cliente.focus();
                }
            }

            if(
                clients.openWindow
            ){
                return clients.openWindow(
                    destino
                );
            }

        })
    );
});
