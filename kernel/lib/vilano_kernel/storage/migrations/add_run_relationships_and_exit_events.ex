defmodule VilanoKernel.Storage.Migrations.AddRunRelationshipsAndExitEvents do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 10
  def name, do: "add_run_relationships_and_exit_events"

  def up do
    VilanoKernel.Storage.ensure_column!("runs", "trap_exits", "integer not null default 0")

    SQL.query!(
      Repo,
      """
      create table if not exists run_relationships (
        id text primary key,
        owner_run_id text not null,
        op_key text not null,
        target_run_id text not null,
        kind text not null,
        propagate text not null,
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
      create table if not exists run_exit_events (
        id text primary key,
        run_id text not null,
        relationship_id text not null,
        event_json text not null,
        consumed_at text,
        created_at text not null,
        unique (relationship_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_relationships_target_status_idx
      on run_relationships(target_run_id, status, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_exit_events_run_consumed_created_idx
      on run_exit_events(run_id, consumed_at, created_at)
      """,
      []
    )
  end
end
