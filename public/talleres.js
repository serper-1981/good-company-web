document.addEventListener('DOMContentLoaded', () => {
    cargarTalleres();
    cargarColores();
    cargarColoresMaterial();

    document.getElementById('btn-agregar-taller').addEventListener('click', agregarTaller);
    document.getElementById('btn-agregar-color').addEventListener('click', agregarColor);
    document.getElementById('btn-agregar-color-material').addEventListener('click', agregarColorMaterial);

    document.getElementById('nuevo-taller').addEventListener('keydown', e => {
        if (e.key === 'Enter') agregarTaller();
    });

    document.getElementById('nuevo-color').addEventListener('keydown', e => {
        if (e.key === 'Enter') agregarColor();
    });

    document.getElementById('nuevo-color-material').addEventListener('keydown', e => {
        if (e.key === 'Enter') agregarColorMaterial();
    });
});

// ======================================================
// TALLERES
// ======================================================

async function cargarTalleres() {
    try {
        const res = await fetch('/api/talleres', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const talleres = await res.json();
        const lista = document.getElementById('lista-talleres');
        lista.innerHTML = '';

        let activos = 0;

        talleres.forEach(taller => {
            if (!taller.activo) return;
            activos++;

            const div = document.createElement('div');
            div.className = 'flex justify-between items-center bg-slate-50 border border-slate-200 rounded-lg px-4 py-3';
            div.innerHTML = `
                <span class="font-medium">${escapeHtml(taller.nombre)}</span>
                <button onclick="eliminarTaller(${Number(taller.id)}, '${escapeHtml(taller.nombre)}')" class="text-red-500 hover:text-red-700 font-bold px-2">
                    🗑
                </button>
            `;
            lista.appendChild(div);
        });

        document.getElementById('contador-talleres').textContent = activos;
    } catch (error) {
        console.error('❌ Error al cargar talleres:', error);
    }
}

async function agregarTaller() {
    const input = document.getElementById('nuevo-taller');
    const nombre = input.value.trim();

    if (!nombre) {
        alert('Escribí el nombre del taller.');
        input.focus();
        return;
    }

    try {
        const res = await fetch('/api/admin/talleres', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre })
        });

        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo crear el taller:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        input.value = '';
        await cargarTalleres();
        input.focus();
    } catch (error) {
        console.error('❌ Error agregando taller:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

async function eliminarTaller(id, nombre) {
    if (!confirm(`¿Querés quitar el taller "${nombre}" de la lista?`)) return;

    try {
        const res = await fetch(`/api/admin/talleres/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo eliminar:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        await cargarTalleres();
    } catch (error) {
        console.error('❌ Error eliminando taller:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

// ======================================================
// COLORES
// ======================================================

async function cargarColores() {
    try {
        const res = await fetch('/api/colores', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const colores = await res.json();
        const lista = document.getElementById('lista-colores');
        lista.innerHTML = '';

        let activos = 0;

        colores.forEach(color => {
            if (!color.activo) return;
            activos++;

            const div = document.createElement('div');
            div.className = 'flex justify-between items-center bg-slate-50 border border-slate-200 rounded-lg px-4 py-3';
            div.innerHTML = `
                <span class="font-medium">${escapeHtml(color.nombre)}</span>
                <button onclick="eliminarColor(${Number(color.id)}, '${escapeHtml(color.nombre)}')" class="text-red-500 hover:text-red-700 font-bold px-2">
                    🗑
                </button>
            `;
            lista.appendChild(div);
        });

        document.getElementById('contador-colores').textContent = activos;
    } catch (error) {
        console.error('❌ Error al cargar colores:', error);
    }
}

async function agregarColor() {
    const input = document.getElementById('nuevo-color');
    const nombre = input.value.trim();

    if (!nombre) {
        alert('Escribí el nombre del color.');
        input.focus();
        return;
    }

    try {
        const res = await fetch('/api/admin/colores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre })
        });

        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo crear el color:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        input.value = '';
        await cargarColores();
        input.focus();
    } catch (error) {
        console.error('❌ Error agregando color:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

async function eliminarColor(id, nombre) {
    if (!confirm(`¿Querés quitar el color "${nombre}" de la lista?`)) return;

    try {
        const res = await fetch(`/api/admin/colores/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo eliminar:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        await cargarColores();
    } catch (error) {
        console.error('❌ Error eliminando color:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

// ======================================================
// COLOR MATERIAL
// ======================================================

async function cargarColoresMaterial() {
    try {
        const res = await fetch('/api/colores-material', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

        const colores = await res.json();
        const lista = document.getElementById('lista-colores-material');
        lista.innerHTML = '';

        let activos = 0;

        colores.forEach(color => {
            if (!color.activo) return;
            activos++;

            const div = document.createElement('div');
            div.className = 'flex justify-between items-center bg-slate-50 border border-slate-200 rounded-lg px-4 py-3';
            div.innerHTML = `
                <span class="font-medium">${escapeHtml(color.nombre)}</span>
                <button onclick="eliminarColorMaterial(${Number(color.id)}, '${escapeHtml(color.nombre)}')" class="text-red-500 hover:text-red-700 font-bold px-2">
                    🗑
                </button>
            `;
            lista.appendChild(div);
        });

        document.getElementById('contador-colores-material').textContent = activos;
    } catch (error) {
        console.error('❌ Error al cargar color material:', error);
        document.getElementById('lista-colores-material').innerHTML = `
            <div class="text-sm text-red-500 py-2">
                No se pudo cargar COLOR MATERIAL.
                <br>
                <span class="text-slate-500">Los colores materiales se leen de la columna B de la hoja "COLORES".</span>
            </div>
        `;
    }
}

async function agregarColorMaterial() {
    const input = document.getElementById('nuevo-color-material');
    const nombre = input.value.trim();

    if (!nombre) {
        alert('Escribí el nombre del color material.');
        input.focus();
        return;
    }

    try {
        const res = await fetch('/api/colores-material', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre })
        });

        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo crear el color material:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        input.value = '';
        await cargarColoresMaterial();
        input.focus();
    } catch (error) {
        console.error('❌ Error agregando color material:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

async function eliminarColorMaterial(id, nombre) {
    if (!confirm(`¿Querés quitar el color material "${nombre}" de la lista?`)) return;

    try {
        const res = await fetch(`/api/colores-material/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (!res.ok) {
            alert('❌ No se pudo eliminar:\n\n' + (data.error || 'Error desconocido.'));
            return;
        }

        await cargarColoresMaterial();
    } catch (error) {
        console.error('❌ Error eliminando color material:', error);
        alert('❌ Error de conexión con el servidor.');
    }
}

// ======================================================
// SEGURIDAD
// ======================================================

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}
