defmodule VilanoKernel.Storage.Migrations.AddRuntimePruneIndexes do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 15
  def name, do: "add_runtime_prune_indexes"

  def up do
    SQL.query!(
      Repo,
      """
      create index if not exists runs_definition_status_lease_updated_idx
      on runs(definition_kind, status, lease_id, updated_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists runs_lease_status_idx
      on runs(lease_id, status)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists runs_status_lease_idx
      on runs(status, lease_id)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_events_event_type_idx
      on run_events(event_type)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_signals_run_created_idx
      on run_signals(run_id, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists service_envelopes_status_updated_idx
      on service_envelopes(status, updated_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists service_envelopes_sender_run_idx
      on service_envelopes(sender_run_id)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_service_refs_service_run_idx
      on run_service_refs(service_run_id)
      """,
      []
    )
  end
end
