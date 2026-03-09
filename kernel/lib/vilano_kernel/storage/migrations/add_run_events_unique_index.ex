defmodule VilanoKernel.Storage.Migrations.AddRunEventsUniqueIndex do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 9
  def name, do: "add_run_events_unique_index"

  def up do
    SQL.query!(
      Repo,
      """
      create unique index if not exists run_events_run_id_seq_idx
      on run_events(run_id, seq)
      """,
      []
    )
  end
end
