-- Migración 022 (2026-10-30): respuesta estructurada de la pregunta «Información altamente confidencial».
-- Solo agrega una columna. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-022.sql
-- respuestas.datos guarda, en JSON, lo que la persona marcó en una pregunta que no es de texto libre:
--   {"confidencial":"si"|"no","cual":"…","ubicaciones":["correo","sharepoint",…],"otro":"…"}
ALTER TABLE respuestas ADD COLUMN datos TEXT NOT NULL DEFAULT '{}';
