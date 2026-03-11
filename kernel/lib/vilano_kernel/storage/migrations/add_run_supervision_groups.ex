defmodule VilanoKernel.Storage.Migrations.AddRunSupervisionGroups do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 11
  def name, do: "add_run_supervision_groups"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_groups (
        id text primary key,
        owner_run_id text not null,
        op_key text not null,
        strategy text not null,
        max_restarts integer not null,
        window_ms integer not null,
        on_exhausted text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        unique (owner_run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_members (
        group_id text not null,
        member_key text not null,
        definition_name text not null,
        input_json text not null,
        current_child_run_id text,
        generation integer not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        primary key (group_id, member_key),
        unique (current_child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_restarts (
        id text primary key,
        group_id text not null,
        member_key text not null,
        child_run_id text not null,
        created_at text not null,
        unique (child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_groups_owner_status_idx
      on run_supervision_groups(owner_run_id, status, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_members_child_idx
      on run_supervision_members(current_child_run_id)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_restarts_group_created_idx
      on run_supervision_restarts(group_id, created_at)
      """,
      []
    )
  end
end
