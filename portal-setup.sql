-- ============================================================
-- 会员下载门户 · 初始化 SQL（v2 修正版：先建表后建函数）
--
-- 用法：Supabase 控制台 → SQL Editor → New query
--       → 粘贴全部 → Run（可重复运行，不会冲突）
-- ============================================================

-- 1. 管理员名单（必须先于 is_admin 函数创建）------------------
create table if not exists public.admins (
  email text primary key
);
alter table public.admins enable row level security;
drop policy if exists "admins_self_read" on public.admins;
create policy "admins_self_read"
  on public.admins for select
  using (email = auth.jwt() ->> 'email');

-- 2. 管理员判断函数（安全定义者，绕过 RLS）--------------------
create or replace function public.is_admin ()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where email = auth.jwt() ->> 'email');
$$;

-- 3. 软件发布表 ------------------------------------------------
create table if not exists public.releases (
  id           uuid primary key default gen_random_uuid(),
  software     text not null,
  version      text not null,
  notes        text not null default '',
  file_path    text not null,
  file_size    bigint not null default 0,
  is_active    boolean not null default true,
  published_at timestamptz not null default now()
);
alter table public.releases enable row level security;

drop policy if exists "releases_read" on public.releases;
create policy "releases_read"
  on public.releases for select
  using (is_active or is_admin());
drop policy if exists "releases_admin_write" on public.releases;
create policy "releases_admin_write"
  on public.releases for insert
  with check (is_admin());
drop policy if exists "releases_admin_update" on public.releases;
create policy "releases_admin_update"
  on public.releases for update
  using (is_admin());
drop policy if exists "releases_admin_delete" on public.releases;
create policy "releases_admin_delete"
  on public.releases for delete
  using (is_admin());

-- 4. 会员表（每个注册用户一行，过期时间即会员有效期）----------
create table if not exists public.memberships (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null default '',
  level      text not null default 'member',
  expires_at timestamptz not null default '1970-01-01'::timestamptz,
  created_at timestamptz not null default now()
);
alter table public.memberships enable row level security;

drop policy if exists "memberships_own_read" on public.memberships;
create policy "memberships_own_read"
  on public.memberships for select
  using (auth.uid() = user_id or is_admin());
drop policy if exists "memberships_own_insert" on public.memberships;
create policy "memberships_own_insert"
  on public.memberships for insert
  with check (auth.uid() = user_id and level = 'member');
drop policy if exists "memberships_admin_update" on public.memberships;
create policy "memberships_admin_update"
  on public.memberships for update
  using (is_admin());

-- 新注册用户自动建会员行 --------------------------------------
create or replace function public.handle_new_user ()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.memberships (user_id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user ();

-- 5. 激活码表（客户不可查询，只能兑换）------------------------
create table if not exists public.license_codes (
  code       text primary key,
  days       int not null default 30,
  note       text not null default '',
  used_by    uuid references auth.users (id),
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table public.license_codes enable row level security;

drop policy if exists "codes_admin_all" on public.license_codes;
create policy "codes_admin_all"
  on public.license_codes for all
  using (is_admin())
  with check (is_admin());

-- 6. 下载日志 --------------------------------------------------
create table if not exists public.download_logs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  release_id uuid not null references public.releases (id) on delete cascade,
  at         timestamptz not null default now()
);
alter table public.download_logs enable row level security;

drop policy if exists "dlog_own_insert" on public.download_logs;
create policy "dlog_own_insert"
  on public.download_logs for insert
  with check (auth.uid() = user_id);
drop policy if exists "dlog_read" on public.download_logs;
create policy "dlog_read"
  on public.download_logs for select
  using (auth.uid() = user_id or is_admin());

-- 7. 激活码兑换函数（原子操作：核销码 + 延长会员）--------------
create or replace function public.redeem_code (p_code text)
returns timestamptz
language plpgsql security definer
set search_path = public
as $$
declare
  v_code text;
  v_days int;
  v_exp  timestamptz;
begin
  if auth.uid() is null then
    raise exception '请先登录再激活';
  end if;

  v_code := upper(btrim(coalesce(p_code, '')));
  if v_code = '' then
    raise exception '请输入激活码';
  end if;

  select days into v_days
  from license_codes
  where code = v_code and used_by is null
  for update;
  if not found then
    raise exception '激活码无效或已被使用';
  end if;

  update license_codes
  set used_by = auth.uid(), used_at = now()
  where code = v_code;

  insert into memberships (user_id, email, expires_at)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), now() + make_interval(days => v_days))
  on conflict (user_id) do nothing;

  select expires_at into v_exp
  from memberships
  where user_id = auth.uid()
  for update;

  if v_exp < now() then
    update memberships
    set expires_at = now() + make_interval(days => v_days)
    where user_id = auth.uid()
    returning expires_at into v_exp;
  else
    update memberships
    set expires_at = v_exp + make_interval(days => v_days)
    where user_id = auth.uid()
    returning expires_at into v_exp;
  end if;

  return v_exp;
end;
$$;

-- 8. 发布文件存储桶（私有 · 会员才能生成下载链接）--------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('releases', 'releases', false, 524288000)
on conflict (id) do update set file_size_limit = 524288000;

drop policy if exists "rel_member_read" on storage.objects;
create policy "rel_member_read"
  on storage.objects for select
  using (bucket_id = 'releases'
         and (exists (select 1 from public.memberships m
                      where m.user_id = auth.uid() and m.expires_at > now())
              or public.is_admin ()));
drop policy if exists "rel_admin_all" on storage.objects;
create policy "rel_admin_all"
  on storage.objects for all
  using (bucket_id = 'releases' and public.is_admin ())
  with check (bucket_id = 'releases' and public.is_admin ());

-- ============================================================
-- ★★★ 管理员邮箱（已填好：gongnicole520@gmail.com）★★★
-- ============================================================
insert into public.admins (email) values ('gongnicole520@gmail.com')
on conflict (email) do nothing;
