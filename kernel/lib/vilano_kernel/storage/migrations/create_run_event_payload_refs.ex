defmodule VilanoKernel.Storage.Migrations.CreateRunEventPayloadRefs do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 14
  def name, do: "create_run_event_payload_refs"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists run_event_payload_refs (
        event_id text primary key,
        run_id text not null,
        payload_path text not null,
        sha256 text not null,
        bytes integer not null,
        created_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_event_payload_refs_payload_path_idx
      on run_event_payload_refs(payload_path)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_event_payload_refs_run_id_idx
      on run_event_payload_refs(run_id)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create trigger if not exists run_event_payload_refs_delete_run_event
      after delete on run_events
      for each row
      begin
        delete from run_event_payload_refs where event_id = old.id;
      end
      """,
      []
    )
  end
end
