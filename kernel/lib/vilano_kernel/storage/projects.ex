defmodule VilanoKernel.Storage.Projects do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.ProjectContract
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Infrastructure

  def project_count do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!("select count(*) from projects", [])
        |> first_integer()
      end,
      :public_read
    )
  end

  def list_projects do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select
            name,
            path,
            snapshot_path,
            last_synced_at,
            definitions_manifest_hash,
            workflows_json,
            services_json
          from projects
          order by name asc
          """,
          []
        )
        |> rows_to_maps()
        |> Enum.map(&project_from_row/1)
      end,
      :public_read
    )
  end

  def get_project(name) do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select
            name,
            path,
            snapshot_path,
            last_synced_at,
            definitions_manifest_hash,
            workflows_json,
            services_json
          from projects
          where name = ?
          """,
          [name]
        )
        |> rows_to_maps()
        |> List.first()
        |> case do
          nil -> nil
          row -> project_from_row(row)
        end
      end,
      :public_read
    )
  end

  def upsert_project!(project) do
    persist_project!(project, :upsert)
    get_project(Map.fetch!(project, "name"))
  end

  def create_project(project) do
    project_name = Map.fetch!(project, "name")

    write_project!(fn ->
      case get_project(project_name) do
        nil ->
          persist_project!(project, :upsert)
          get_project(project_name)

        _existing ->
          nil
      end
    end)
  end

  def remove_project(name) do
    write_project!(fn ->
      project = get_project(name)

      if project do
        SQL.query!(Repo, "delete from projects where name = ?", [name])
      end

      project
    end)
  end

  defp persist_project!(project, mode) do
    project =
      case ProjectContract.validate(project) do
        {:ok, validated} -> validated
        {:error, message} -> raise ArgumentError, message
      end

    workflows_json = Jason.encode!(get_in(project, ["definitions", "workflows"]) || [])
    services_json = Jason.encode!(get_in(project, ["definitions", "services"]) || [])

    write_project!(fn ->
      SQL.query!(
        Repo,
        """
        insert into projects (
          name,
          path,
          snapshot_path,
          last_synced_at,
          definitions_manifest_hash,
          workflows_json,
          services_json
        ) values (?, ?, ?, ?, ?, ?, ?)
        #{project_insert_conflict_clause(mode)}
        """,
        [
          Map.fetch!(project, "name"),
          Map.fetch!(project, "path"),
          Map.get(project, "snapshotPath") || Map.fetch!(project, "path"),
          Map.get(project, "lastSyncedAt"),
          Map.get(project, "definitionsManifestHash"),
          workflows_json,
          services_json
        ]
      )

      :ok
    end)
  end

  defp write_project!(fun) do
    if Repo.in_transaction?() do
      fun.()
    else
      case Infrastructure.transaction_with_busy_retry(fun, :admin_control) do
        {:ok, result} -> result
        {:error, reason} -> raise inspect(reason)
      end
    end
  end

  defp project_insert_conflict_clause(:upsert) do
    """
    on conflict(name) do update set
      path = excluded.path,
      snapshot_path = excluded.snapshot_path,
      last_synced_at = excluded.last_synced_at,
      definitions_manifest_hash = excluded.definitions_manifest_hash,
      workflows_json = excluded.workflows_json,
      services_json = excluded.services_json
    """
  end

  def list_definitions(kind, project_name \\ nil)

  def list_definitions(kind, nil) do
    list_projects()
    |> Enum.flat_map(&definitions_for_kind(&1, kind))
  end

  def list_definitions(kind, project_name) do
    case get_project(project_name) do
      nil -> nil
      project -> definitions_for_kind(project, kind)
    end
  end

  def get_definition(project_name, kind, definition_name) do
    with project when not is_nil(project) <- get_project(project_name) do
      find_definition(project, kind, definition_name)
    end
  end

  def find_definition(project, kind, definition_name) when is_map(project) do
    definitions_for_kind(project, kind)
    |> Enum.find(&(&1["name"] == definition_name))
  end

  defp definitions_for_kind(project, "workflow"), do: project["definitions"]["workflows"]
  defp definitions_for_kind(project, "service"), do: project["definitions"]["services"]

  defp project_from_row(row) do
    %{
      "name" => row["name"],
      "path" => row["path"],
      "snapshotPath" => row["snapshot_path"] || row["path"],
      "lastSyncedAt" => row["last_synced_at"],
      "definitionsManifestHash" => row["definitions_manifest_hash"],
      "definitions" => %{
        "workflows" => decode_json_value(row["workflows_json"], []),
        "services" => decode_json_value(row["services_json"], [])
      }
    }
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

  defp first_integer(%{rows: [[value]]}) when is_integer(value), do: value
  defp first_integer(%{rows: [[value]]}) when is_binary(value), do: String.to_integer(value)
end
