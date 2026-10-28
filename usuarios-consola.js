/* Consola de MBC · usuarios: crear y editar a una persona (nombre, sección y procesos) y mostrar las claves que genera una carga por Excel.
 * Los perfiles Supervisor y Gerente están en pausa: no se ofrecen al crear o editar, y quien ya tiene uno lo conserva.
 * Se carga desde admin.html y recibe lo que necesita de la consola en UsuariosConsola.iniciar().
 */
(function(){
  'use strict';
  var X = null;   // lo que entrega la consola (api, datos, diálogos, correo…)
  function esc(s){ return X.esc(s); }
  function sin(s){ return X.sinTildes(String(s == null ? '' : s).trim().replace(/\s+/g, ' ')); }
  function plural(n, uno, varios){ return n + ' ' + (n === 1 ? uno : varios); }
  function nombreProc(p){ return p.subproceso || p.proceso || p.macroproceso || '(sin nombre)'; }
  function iniciar(opciones){ X = opciones; }

  // Gerencias y secciones de la campaña: las de los procesos, las del esqueleto y las de las personas (aunque aún no tengan procesos).
  function arbolCampana(){
    var C = X.datos(), g = {};
    var sumar = function(ger, sec){ if (!ger) return; var k = Object.keys(g).filter(function(x){ return sin(x) === sin(ger); })[0] || ger; g[k] = g[k] || {}; if (sec){ var s = Object.keys(g[k]).filter(function(x){ return sin(x) === sin(sec); })[0] || sec; g[k][s] = 1; } };
    C.procesos.forEach(function(p){ sumar(p.gerencia, p.seccion); });
    (C.estructura || []).forEach(function(f){ sumar(f.gerencia, f.seccion); });
    C.encuestados.forEach(function(e){ sumar(e.gerencia, e.seccion); });
    return g;
  }

  // ---------------------------------------------------------------- crear o editar a una persona
  function abrir(id){
    var C = X.datos(), en = id ? C.encuestados.filter(function(x){ return x.id === id; })[0] : null;
    if (id && !en) return;
    var cuenta = en ? (C.supervisores || []).filter(function(s){ return s.encuestado_id === en.id && s.activo; })[0] : null;
    var perfil = en ? (en.perfil || 'responsable') : 'responsable';
    var arbol = arbolCampana(), gers = Object.keys(arbol).sort(function(a, b){ return a.localeCompare(b, 'es'); });
    // Secciones ya cubiertas por la persona: las de su alcance (Supervisor o Gerente) y aquellas cuyos procesos tiene todos asignados.
    var asign = {}; (C.asignaciones || []).forEach(function(a){ if (en && a.encuestado_id === en.id && a.origen !== 'excluido') asign[a.proceso_id] = 1; });
    var marcada = {};
    if (en){
      var porSec = {}; C.procesos.forEach(function(p){ var k = sin(p.gerencia) + '|' + sin(p.seccion); (porSec[k] = porSec[k] || []).push(p.id); });
      Object.keys(porSec).forEach(function(k){ if (porSec[k].every(function(pid){ return asign[pid]; })) marcada[k] = 1; });
      var al = cuenta && cuenta.alcance;
      if (al) (al.secciones || []).forEach(function(x){ marcada[sin(x.g) + '|' + sin(x.s)] = 1; });
    }
    var selP = {};
    var arbolHtml = gers.map(function(g){
      return '<div style="margin:6px 0"><b>' + esc(g) + '</b><div style="margin-left:14px">' + Object.keys(arbol[g]).sort(function(a, b){ return a.localeCompare(b, 'es'); }).map(function(s){
        var n = C.procesos.filter(function(p){ return sin(p.gerencia) === sin(g) && sin(p.seccion) === sin(s); }).length;
        return '<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" style="width:auto" data-g="' + esc(g) + '" data-s="' + esc(s) + '"' + (marcada[sin(g) + '|' + sin(s)] ? ' checked' : '') + '> ' + esc(s) +
          ' <span class="muted">' + (n ? plural(n, 'proceso', 'procesos') : 'sin procesos todavía') + '</span></label>';
      }).join('') + '</div></div>';
    }).join('');
    X.abrirDlg(en ? 'Editar usuario' : 'Nuevo usuario', en ? en.nombre : 'Datos de la persona y los procesos que recibe',
      '<div class="grid2"><div><label for="ucNom">Nombre completo</label><input type="text" id="ucNom" maxlength="150" value="' + esc(en ? en.nombre : '') + '"></div>' +
      '<div><label for="ucCor">Correo</label><input type="email" id="ucCor" maxlength="150" value="' + esc(en ? en.correo : '') + '"></div></div>' +
      '<div class="grid2"><div><label for="ucRol">Cargo o rol (opcional)</label><input type="text" id="ucRol" maxlength="60" value="' + esc(en ? en.rol : '') + '"></div></div>' +
      '<div class="grid2"><div><label for="ucGer">Gerencia principal</label><input type="text" id="ucGer" list="dlGer" maxlength="150" autocomplete="off" value="' + esc(en ? en.gerencia : '') + '"></div>' +
      '<div><label for="ucSec">Sección principal</label><input type="text" id="ucSec" list="dlSec" maxlength="150" autocomplete="off" value="' + esc(en ? en.seccion : '') + '"></div></div>' +
      '<h4 style="font-size:13px;margin:14px 0 4px">Secciones: recibe todos sus procesos a la vez' + (en ? ' <span class="muted" style="font-weight:500">(se suman a lo que ya tiene: ' + plural(Object.keys(asign).length, 'proceso asignado', 'procesos asignados') + ')</span>' : '') + '</h4>' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="ucPrincipal" style="width:auto"' + (en ? '' : ' checked') + '> Asignarle todos los procesos de su sección principal</label>' +
      '<div id="ucArbol" style="max-height:26vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px 10px;margin-top:6px">' + (arbolHtml || '<p class="muted">Todavía no hay gerencias ni secciones en la campaña.</p>') + '</div>' +
      '<label for="ucBusP" style="margin-top:10px">Procesos específicos (opcional)</label><input type="search" id="ucBusP" placeholder="Busca un proceso por nombre o código…" autocomplete="off"><div id="ucResP"></div><div id="ucChips" class="row" style="margin-top:6px"></div>' +
      '<div class="row" style="margin-top:14px"><button type="button" class="btn" id="ucOk">' + (en ? 'Guardar cambios' : 'Crear usuario') + '</button><span class="muted" id="ucMsg" role="status"></span></div>');
    var $ = function(s){ return document.querySelector(s); }, procs = C.procesos;
    var chips = function(){
      $('#ucChips').innerHTML = Object.keys(selP).map(function(pid){
        var p = procs.filter(function(q){ return q.id === pid; })[0];
        return p ? '<span class="chip c-inf">' + esc(nombreProc(p)) + ' <button type="button" class="btn-link" data-q="' + esc(pid) + '" aria-label="Quitar">✕</button></span>' : '';
      }).join('');
    };
    chips();
    document.getElementById('dlgB').onclick = function(ev){
      var q = ev.target.closest('[data-q]'); if (q){ delete selP[q.dataset.q]; chips(); return; }
      var r = ev.target.closest('[data-r]'); if (r){ selP[r.dataset.r] = 1; chips(); $('#ucBusP').value = ''; $('#ucResP').innerHTML = ''; }
    };
    $('#ucBusP').addEventListener('input', function(){
      var t = sin(this.value); if (t.length < 2){ $('#ucResP').innerHTML = ''; return; }
      var h = procs.filter(function(p){ return !selP[p.id] && !asign[p.id] && sin([p.codigo, nombreProc(p), p.macroproceso, p.seccion].join(' ')).indexOf(t) >= 0; }).slice(0, 8);
      $('#ucResP').innerHTML = h.length ? h.map(function(p){ return '<div><button type="button" class="btn btn-ghost btn-xs" data-r="' + esc(p.id) + '" style="margin:2px 0;text-align:left">' + esc(nombreProc(p) + ' — ' + p.gerencia + ' · ' + p.seccion) + '</button></div>'; }).join('') : '<p class="muted">Sin resultados.</p>';
    });
    $('#ucOk').addEventListener('click', function(){
      var b = this, ger = $('#ucGer').value.trim(), sec = $('#ucSec').value.trim();
      var secciones = Array.prototype.map.call(document.querySelectorAll('#ucArbol input:checked'), function(i){ return {g: i.dataset.g, s: i.dataset.s}; });
      if ($('#ucPrincipal').checked && ger && sec) secciones.push({g: ger, s: sec});
      var cuerpo = {campana_id: C.campana.id, nombre: $('#ucNom').value, correo: $('#ucCor').value, rol: $('#ucRol').value, perfil: perfil, gerencia: ger, seccion: sec, secciones: secciones, procesos: Object.keys(selP)};
      if (en) cuerpo.id = en.id;
      b.disabled = true; $('#ucMsg').textContent = 'Guardando…';
      X.api('/a/usuario', cuerpo).then(function(j){
        C.supervisores = j.supervisores || C.supervisores;
        return X.recargar().then(function(){
          var nuevo = {id: j.id, nombre: cuerpo.nombre.trim(), correo: cuerpo.correo.trim(), gerencia: ger, seccion: sec};
          if (j.clave) X.accesoPerfil(nuevo, j);
          else document.getElementById('dlg').close();
          X.aviso(en ? 'Usuario actualizado' + (j.asignados ? ': se le asignaron ' + plural(j.asignados, 'proceso', 'procesos') + '.' : '.') : 'Usuario creado' + (j.asignados ? ' con ' + plural(j.asignados, 'proceso asignado', 'procesos asignados') + '.' : '.'));
        });
      }).catch(function(err){ b.disabled = false; $('#ucMsg').textContent = err.message; });
    });
  }

  // ---------------------------------------------------------------- claves que devuelve una carga por Excel
  function mostrarClaves(claves){
    if (!claves || !claves.length) return;
    var panel = X.enlaceCliente();
    X.abrirDlg('Claves de la carga', plural(claves.length, 'cuenta creada', 'cuentas creadas'),
      '<p style="margin-top:0"><b>Las claves solo se muestran ahora.</b> Descárgalas y guárdalas: después solo se pueden reemplazar por una nueva.</p>' +
      '<div class="tblwrap"><table><thead><tr><th scope="col">Persona</th><th scope="col">Perfil</th><th scope="col">Clave</th></tr></thead><tbody>' + claves.map(function(c){
        return '<tr><td><b>' + esc(c.nombre) + '</b>' + (c.correo ? '<div class="muted">' + esc(c.correo) + '</div>' : '') + '</td><td>' + (c.perfil === 'gerente' ? 'Gerente' : 'Supervisor') + '</td><td><code>' + esc(c.clave) + '</code></td></tr>';
      }).join('') + '</tbody></table></div><p class="muted">Dirección del panel: <code>' + esc(panel) + '</code></p>' +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn btn-xs" id="clDescargar">Descargar claves (Excel)</button><button type="button" class="btn btn-ghost btn-xs" id="clCerrar">Terminar</button></div>');
    document.getElementById('clDescargar').onclick = function(){
      var ws = XLSX.utils.json_to_sheet(claves.map(function(c){ return {Nombre: c.nombre, Correo: c.correo, Perfil: c.perfil === 'gerente' ? 'Gerente' : 'Supervisor', 'Enlace del panel': panel, 'Clave personal': c.clave}; }));
      ws['!cols'] = [{wch:28},{wch:30},{wch:12},{wch:60},{wch:26}];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Claves');
      XLSX.writeFile(wb, 'Claves de acceso - ' + X.datos().campana.nombre + '.xlsx');
    };
    document.getElementById('clCerrar').onclick = function(){ document.getElementById('dlg').close(); };
  }

  window.UsuariosConsola = {iniciar: iniciar, abrir: abrir, mostrarClaves: mostrarClaves};
})();
