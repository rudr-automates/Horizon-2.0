-- Horizon Phase 1: close a cross-tenant reference gap.
--
-- focus_sessions.user_id was protected by RLS, but task_id only had a plain
-- foreign key, so a learner could attach their own session to another learner's
-- task UUID if they knew it. The trigger checks ownership using the inserting
-- learner's RLS-visible tasks. Additive; no rows are changed.
--
-- Written but NOT applied by the Phase 1 run.

create or replace function public.enforce_focus_task_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.task_id is not null then
    if not exists (
      select 1
      from public.tasks t
      where t.id = new.task_id and t.user_id = new.user_id
    ) then
      raise exception 'focus session task must belong to the same learner'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger focus_task_owner_guard
  before insert or update of task_id, user_id on public.focus_sessions
  for each row execute function public.enforce_focus_task_owner();

revoke execute on function public.enforce_focus_task_owner() from public, anon, authenticated;

comment on function public.enforce_focus_task_owner() is
  'Rejects a focus session that references a task owned by a different learner.';

-- Manual rollback:
-- drop trigger if exists focus_task_owner_guard on public.focus_sessions;
-- drop function if exists public.enforce_focus_task_owner();
