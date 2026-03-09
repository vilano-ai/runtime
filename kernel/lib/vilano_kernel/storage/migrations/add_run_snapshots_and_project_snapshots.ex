defmodule VilanoKernel.Storage.Migrations.AddRunSnapshotsAndProjectSnapshots do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 4
  def name, do: "add_run_snapshots_and_project_snapshots"

  def up do
    VilanoKernel.Storage.ensure_column!("projects", "snapshot_path", "text")
    SQL.query!(Repo, "update projects set snapshot_path = path where snapshot_path is null", [])

    VilanoKernel.Storage.ensure_column!("runs", "project_snapshot_path", "text")
    VilanoKernel.Storage.ensure_column!("runs", "project_definitions_json", "text")
    VilanoKernel.Storage.ensure_column!("runs", "definition_file", "text")
    VilanoKernel.Storage.ensure_column!("runs", "definition_export_name", "text")
    VilanoKernel.Storage.ensure_column!("runs", "definition_runtime_kind", "text")
    VilanoKernel.Storage.ensure_column!("runs", "definition_source_language", "text")
  end
end
