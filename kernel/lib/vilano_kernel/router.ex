defmodule VilanoKernel.Router do
  @moduledoc false

  use Plug.Router

  alias Plug.Conn
  alias VilanoKernel.Storage

  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason

  plug :dispatch

  get "/v1/status" do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    send_json(conn, 200, %{
      ok: true,
      port: runtime.port,
      startedAt: runtime.started_at,
      runtimeDbPath: runtime.runtime_db_path,
      projectCount: Storage.project_count()
    })
  end

  get "/v1/projects" do
    send_json(conn, 200, %{
      ok: true,
      projects: Storage.list_projects()
    })
  end

  post "/v1/projects" do
    project = Storage.upsert_project!(project_payload(conn.body_params))
    send_json(conn, 200, %{ok: true, project: project})
  end

  get "/v1/projects/:name" do
    case Storage.get_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  post "/v1/projects/:name/sync" do
    project =
      conn.body_params
      |> project_payload()
      |> Map.put("name", name)
      |> Storage.upsert_project!()

    send_json(conn, 200, %{ok: true, project: project})
  end

  delete "/v1/projects/:name" do
    case Storage.remove_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  get "/v1/workflows" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("workflow", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  get "/v1/services" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("service", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  get "/v1/workflows/:project/:name" do
    case Storage.get_definition(project, "workflow", name) do
      nil -> send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")
      definition -> send_json(conn, 200, %{ok: true, project: project, definition: definition})
    end
  end

  post "/v1/runs" do
    project = fetch_required_string(conn.body_params, "project")
    workflow = fetch_required_string(conn.body_params, "workflow")

    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "workflow", workflow),
         run <- Storage.create_workflow_run!(project, definition["name"], Map.get(conn.body_params, "input", %{})) do
      _ = project_record
      send_json(conn, 200, %{ok: true, run: run})
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown workflow '#{workflow}' in project '#{project}'")
    end
  end

  get "/v1/runs" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case project_name do
      nil ->
        send_json(conn, 200, %{ok: true, project: nil, runs: Storage.list_runs()})

      name ->
        case Storage.get_project(name) do
          nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
          _project -> send_json(conn, 200, %{ok: true, project: name, runs: Storage.list_runs(name)})
        end
    end
  end

  get "/v1/runs/:id" do
    case Storage.get_run(id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{id}")

      run ->
        send_json(conn, 200, %{ok: true, run: run, events: Storage.list_run_events(id)})
    end
  end

  match _ do
    send_error(conn, 404, "not_found", "Unknown endpoint: #{conn.method} #{conn.request_path}")
  end

  defp project_payload(body_params) do
    %{
      "name" => fetch_required_string(body_params, "name"),
      "path" => fetch_required_string(body_params, "path"),
      "lastSyncedAt" => Map.get(body_params, "lastSyncedAt"),
      "definitionsManifestHash" => Map.get(body_params, "definitionsManifestHash"),
      "definitions" => %{
        "workflows" => get_in(body_params, ["definitions", "workflows"]) || [],
        "services" => get_in(body_params, ["definitions", "services"]) || []
      }
    }
  end

  defp fetch_required_string(body_params, key) do
    case Map.get(body_params, key) do
      value when is_binary(value) and value != "" -> value
      _ -> raise ArgumentError, "expected '#{key}' to be a non-empty string"
    end
  end

  defp list_definitions(kind, nil), do: {:ok, Storage.list_definitions(kind)}

  defp list_definitions(kind, project_name) do
    case Storage.list_definitions(kind, project_name) do
      nil -> {:error, "Unknown project: #{project_name}"}
      definitions -> {:ok, definitions}
    end
  end

  defp send_json(conn, status, body) do
    body = Jason.encode!(body)

    conn
    |> Conn.put_resp_content_type("application/json")
    |> Conn.send_resp(status, body <> "\n")
  end

  defp send_error(conn, status, code, message) do
    send_json(conn, status, %{ok: false, error: %{code: code, message: message}})
  end
end
