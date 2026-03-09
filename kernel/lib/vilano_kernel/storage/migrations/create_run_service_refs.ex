defmodule VilanoKernel.Storage.Migrations.CreateRunServiceRefs do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 6
  def name, do: "create_run_service_refs"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists run_service_refs (
        caller_run_id text not null,
        service_run_id text not null,
        created_at text not null,
        primary key (caller_run_id, service_run_id)
      )
      """,
      []
    )
  end
end
