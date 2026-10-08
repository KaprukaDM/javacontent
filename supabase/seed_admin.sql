-- Creates the first admin. Run AFTER setup.sql, in the Supabase SQL Editor.
-- 1) Replace CHANGE_ME_PASSWORD below with the password you want (min 6 chars).
-- 2) Do NOT commit the edited file.
select public._create_user('admin', 'Administrator', 'CHANGE_ME_PASSWORD', 'admin');
