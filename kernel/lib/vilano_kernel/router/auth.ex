defmodule VilanoKernel.Router.Auth do
  @moduledoc false

  alias Plug.Conn
  alias VilanoKernel.Storage

  import VilanoKernel.Router.Support

  def authenticate_request(conn, runtime) do
    provided =
      conn
      |> Conn.get_req_header("x-vilano-token")
      |> List.first()

    lease_scope = lease_auth_scope(conn, provided)

    cond do
      valid_auth_token?(provided, runtime.auth_token) ->
        Conn.assign(conn, :auth_scope, :daemon)

      lease_scope != nil ->
        conn
        |> Conn.assign(:auth_scope, :lease)
        |> Conn.assign(:lease_id, lease_scope)

      valid_auth_token?(provided, runtime.worker_auth_token) ->
        if worker_bootstrap_request?(conn.method, conn.request_path) do
          Conn.assign(conn, :auth_scope, :worker_bootstrap)
        else
          conn
          |> send_error(401, "unauthorized", "Vilano worker token cannot access this endpoint")
          |> Conn.halt()
        end

      auth_configured?(runtime) ->
        conn
        |> send_error(401, "unauthorized", "Vilano kernel access token is missing or invalid")
        |> Conn.halt()

      conn.request_path == "/v1/status" ->
        conn

      true ->
        conn
        |> send_error(503, "unconfigured_auth", "Vilano kernel access tokens are not configured")
        |> Conn.halt()
    end
  end

  defp auth_configured?(runtime) do
    non_empty_token?(runtime.auth_token) or non_empty_token?(runtime.worker_auth_token)
  end

  defp non_empty_token?(token) when is_binary(token), do: token != ""
  defp non_empty_token?(_token), do: false

  defp worker_bootstrap_request?("GET", "/v1/status"), do: true
  defp worker_bootstrap_request?("POST", "/v1/activations/lease"), do: true
  defp worker_bootstrap_request?(_method, _path), do: false

  defp lease_auth_scope(_conn, token) when not is_binary(token) or token == "", do: nil

  defp lease_auth_scope(conn, token) do
    case requested_lease_id(conn) do
      lease_id when is_binary(lease_id) and lease_id != "" ->
        if Storage.valid_lease_auth_token?(lease_id, token), do: lease_id, else: nil

      _ ->
        nil
    end
  end

  defp requested_lease_id(%Conn{request_path: path, body_params: body_params}) do
    case Regex.run(~r{^/v1/leases/([^/]+)(?:/|$)}, path, capture: :all_but_first) do
      [lease_id] ->
        URI.decode_www_form(lease_id)

      _ ->
        case path do
          "/v1/services/ensure" ->
            case Map.get(body_params, "leaseId") do
              value when is_binary(value) and value != "" -> value
              _ -> nil
            end

          _ ->
            nil
        end
    end
  end

  defp valid_auth_token?(provided, expected)
       when is_binary(provided) and is_binary(expected) and
              byte_size(provided) == byte_size(expected) do
    Plug.Crypto.secure_compare(provided, expected)
  end

  defp valid_auth_token?(_provided, _expected), do: false
end
