defmodule VilanoKernel.Storage.Migrations do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.Migrations.{
    AddRunLeaseAuthToken,
    AddRunRelationshipsAndExitEvents,
    AddRunStepRetryColumns,
    AddRunSnapshotsAndProjectSnapshots,
    AddServiceEnvelopeAttemptColumn,
    FailUnpinnedRuns,
    AddRunEventsUniqueIndex,
    CreateRunEventSequences,
    CreateRunServiceRefs,
    CreateRuntimeMetadata
  }

  @migrations [
    AddRunStepRetryColumns,
    AddServiceEnvelopeAttemptColumn,
    CreateRuntimeMetadata,
    AddRunSnapshotsAndProjectSnapshots,
    CreateRunEventSequences,
    CreateRunServiceRefs,
    AddRunLeaseAuthToken,
    FailUnpinnedRuns,
    AddRunEventsUniqueIndex,
    AddRunRelationshipsAndExitEvents
  ]

  def ensure_tracking_table! do
    SQL.query!(
      Repo,
      """
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      )
      """,
      []
    )
  end

  def run_pending! do
    reject_future_schema!()
    applied_versions = applied_versions() |> MapSet.new()

    Enum.each(@migrations, fn migration ->
      unless MapSet.member?(applied_versions, migration.version()) do
        apply_migration!(migration)
      end
    end)
  end

  def current_version do
    applied_versions()
    |> List.last()
    |> case do
      nil -> 0
      version -> version
    end
  end

  def latest_version do
    @migrations
    |> Enum.map(& &1.version())
    |> Enum.max(fn -> 0 end)
  end

  def applied_migrations do
    Repo
    |> SQL.query!(
      """
      select version, name, applied_at
      from schema_migrations
      order by version asc
      """,
      []
    )
    |> rows_to_maps()
  end

  defp applied_versions do
    applied_migrations()
    |> Enum.map(& &1["version"])
  end

  defp apply_migration!(migration) do
    applied_at = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

    case Repo.transaction(fn ->
           migration.up()

           SQL.query!(
             Repo,
             """
             insert into schema_migrations (version, name, applied_at)
             values (?, ?, ?)
             """,
             [migration.version(), migration.name(), applied_at]
           )
         end) do
      {:ok, _value} ->
        :ok

      {:error, reason} ->
        raise(reason)
    end
  end

  defp reject_future_schema! do
    current_max =
      applied_versions()
      |> Enum.max(fn -> 0 end)

    if current_max > latest_version() do
      raise """
      Vilano kernel schema version #{current_max} is newer than this runtime supports (latest #{latest_version()}).
      Refusing to start against a newer database schema.
      """
    end
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      columns
      |> Enum.zip(row)
      |> Map.new()
    end)
  end
end
