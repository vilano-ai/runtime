defmodule VilanoKernel.Storage.Migrations.CreateRunEventSequences do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 5
  def name, do: "create_run_event_sequences"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists run_event_sequences (
        run_id text primary key,
        next_seq integer not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      insert into run_event_sequences (run_id, next_seq)
      select run_id, coalesce(max(seq), 0) + 1
      from run_events
      group by run_id
      on conflict(run_id) do update set next_seq = excluded.next_seq
      """,
      []
    )
  end
end
