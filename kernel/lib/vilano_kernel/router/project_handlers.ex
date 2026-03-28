defmodule VilanoKernel.Router.ProjectHandlers do
  @moduledoc false

  alias VilanoKernel.Storage

  import VilanoKernel.Router.Support

  def list_projects(conn) do
    send_json(conn, 200, %{ok: true, projects: Storage.list_projects()})
  end

  def create_project(conn) do
    case validate_project_payload(conn.body_params) do
      {:ok, project_payload} ->
        case Storage.create_project!(project_payload) do
          nil ->
            send_error(conn, 409, "project_exists", "Project already exists")

          project ->
            send_json(conn, 200, %{ok: true, project: project})
        end

      {:error, message} ->
        send_error(conn, 400, "invalid_project", message)
    end
  end

  def get_project(conn, name) do
    case Storage.get_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  def sync_project(conn, name) do
    case validate_project_payload(Map.put(conn.body_params, "name", name)) do
      {:ok, project_payload} ->
        project = Storage.upsert_project!(project_payload)
        send_json(conn, 200, %{ok: true, project: project})

      {:error, message} ->
        send_error(conn, 400, "invalid_project", message)
    end
  end

  def delete_project(conn, name) do
    case Storage.remove_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  def purge_project_runtime(conn, name) do
    case Storage.purge_project_runtime(name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown project: #{name}")

      result ->
        send_json(conn, 200, Map.put(result, "ok", true))
    end
  end

  def list_workflows(conn) do
    list_definitions_for(conn, "workflow")
  end

  def list_services(conn) do
    list_definitions_for(conn, "service")
  end

  def list_service_runs(conn) do
    query_params =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params)

    project_name = query_params["project"]
    active_only = query_params["active"] in ["true", "1", "yes"]

    case project_name do
      nil ->
        send_json(conn, 200, %{
          ok: true,
          project: nil,
          activeOnly: active_only,
          runs: Storage.list_service_runs(nil, active_only)
        })

      name ->
        case Storage.get_project(name) do
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{
              ok: true,
              project: name,
              activeOnly: active_only,
              runs: Storage.list_service_runs(name, active_only)
            })
        end
    end
  end

  def get_workflow_definition(conn, project, name) do
    case Storage.get_definition(project, "workflow", name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")

      definition ->
        send_json(conn, 200, %{ok: true, project: project, definition: definition})
    end
  end

  defp list_definitions_for(conn, kind) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions(kind, project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end
end
