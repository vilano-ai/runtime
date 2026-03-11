defmodule VilanoKernel.Storage.Migrations.AddServiceEnvelopeWakeAt do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 12
  def name, do: "add_service_envelope_wake_at"

  def up do
    SQL.query!(
      Repo,
      """
      pragma table_info(service_envelopes)
      """,
      []
    )
    |> maybe_add_wake_at_column!()

    SQL.query!(
      Repo,
      """
      create index if not exists service_envelopes_run_status_wake_created_idx
      on service_envelopes(service_run_id, status, wake_at, created_at)
      """,
      []
    )
  end

  defp maybe_add_wake_at_column!(%{rows: rows}) do
    has_wake_at? =
      Enum.any?(rows, fn row ->
        Enum.at(row, 1) == "wake_at"
      end)

    unless has_wake_at? do
      SQL.query!(
        Repo,
        """
        alter table service_envelopes add column wake_at text
        """,
        []
      )
    end
  end
end
