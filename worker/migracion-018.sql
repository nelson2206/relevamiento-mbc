-- Migración 018 (2026-10-28): se invalidan los enlaces personales (?k=) enviados antes del ingreso con PIN.
-- Cada persona recibe un acceso nuevo que solo se entrega tras verificar su PIN. Nadie pierde su avance: vuelve a entrar con su
-- nombre y su PIN en el enlace de su sección (quien aún no tiene PIN lo crea en ese primer ingreso).
-- Aplicar UNA vez, junto con la 017 y ANTES de desplegar el Worker nuevo:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-017.sql
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-018.sql
-- Para repetir esto más adelante en una campaña concreta no hace falta SQL: usa «Cerrar sesiones activas» en Personas y enlaces.
UPDATE encuestados SET token = lower(hex(randomblob(10)));
