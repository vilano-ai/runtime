defmodule VilanoKernel.Storage.Migrations.AddServiceEnvelopeAttemptColumn do
  @moduledoc false

  def version, do: 2
  def name, do: "add_service_envelope_attempt_column"

  def up do
    VilanoKernel.Storage.ensure_column!("service_envelopes", "attempt", "integer")
  end
end
