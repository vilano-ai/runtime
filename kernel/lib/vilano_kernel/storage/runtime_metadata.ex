defmodule VilanoKernel.Storage.RuntimeMetadata do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Infrastructure
  alias VilanoKernel.Storage.Migrations
  alias VilanoKernel.Version

  def schema_state do
    Infrastructure.run_with_busy_retry(
      fn ->
        %{
          "version" => Migrations.current_version(),
          "appliedMigrations" => Migrations.applied_migrations()
        }
      end,
      :public_read
    )
  end

  def runtime_metadata do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select runtime_version, protocol_version, schema_version, applied_migrations_json, updated_at
          from runtime_metadata
          where id = 1
          """,
          []
        )
        |> rows_to_maps()
        |> List.first()
        |> case do
          nil ->
            nil

          row ->
            %{
              "runtimeVersion" => row["runtime_version"],
              "protocolVersion" => row["protocol_version"],
              "schemaVersion" => row["schema_version"],
              "appliedMigrations" => decode_json_value(row["applied_migrations_json"], []),
              "updatedAt" => row["updated_at"]
            }
        end
      end,
      :public_read
    )
  end

  def sync_runtime_metadata! do
    applied_migrations = Migrations.applied_migrations()
    now = now_iso8601()

    SQL.query!(
      Repo,
      """
      insert into runtime_metadata (
        id,
        runtime_version,
        protocol_version,
        schema_version,
        applied_migrations_json,
        updated_at
      ) values (1, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        runtime_version = excluded.runtime_version,
        protocol_version = excluded.protocol_version,
        schema_version = excluded.schema_version,
        applied_migrations_json = excluded.applied_migrations_json,
        updated_at = excluded.updated_at
      """,
      [
        Version.runtime_version(),
        Version.protocol_version(),
        Migrations.current_version(),
        Jason.encode!(applied_migrations),
        now
      ]
    )
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      columns
      |> Enum.zip(row)
      |> Map.new()
    end)
  end

  defp decode_json_value(nil, fallback), do: fallback
  defp decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)

  defp now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end
end
