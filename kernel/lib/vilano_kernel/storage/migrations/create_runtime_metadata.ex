defmodule VilanoKernel.Storage.Migrations.CreateRuntimeMetadata do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 3
  def name, do: "create_runtime_metadata"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists runtime_metadata (
        id integer primary key check (id = 1),
        runtime_version text not null,
        protocol_version integer not null,
        schema_version integer not null,
        applied_migrations_json text not null,
        updated_at text not null
      )
      """,
      []
    )
  end
end
