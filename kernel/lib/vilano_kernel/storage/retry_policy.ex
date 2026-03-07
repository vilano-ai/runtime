defmodule VilanoKernel.Storage.RetryPolicy do
  @moduledoc false

  def retry_decision(error_body, attempt, max_attempts, retry_on) do
    family = normalize_retry_family(Map.get(error_body, "family"))
    explicit_retryable = Map.get(error_body, "retryable", true) != false
    family_allowed = retry_family_allowed?(family, retry_on)
    retryable = retryable_failure?(error_body, retry_on)
    will_retry = retryable and attempt < max_attempts

    decision =
      cond do
        will_retry -> "scheduled"
        not explicit_retryable -> "non_retryable"
        not family_allowed -> "family_not_selected"
        max_attempts <= 1 -> "retries_disabled"
        true -> "attempts_exhausted"
      end

    %{
      "retryFamily" => family,
      "retryable" => retryable,
      "willRetry" => will_retry,
      "retryDecision" => decision
    }
  end

  def compute_backoff_details(policy, attempt, seed) do
    kind = normalize_backoff_kind(Map.get(policy, "backoffKind"))
    base_ms = normalize_backoff_ms(Map.get(policy, "backoffMs"))
    max_ms = normalize_optional_backoff_ms(Map.get(policy, "maxBackoffMs"))
    jitter_kind = normalize_backoff_jitter_kind(Map.get(policy, "backoffJitterKind"))
    jitter_ratio = normalize_backoff_jitter_ratio(Map.get(policy, "backoffJitterRatio"), jitter_kind)

    base_delay_ms =
      case kind do
        "linear" ->
          step_ms = normalize_optional_backoff_ms(Map.get(policy, "backoffStepMs")) || base_ms
          base_ms + max(attempt - 1, 0) * step_ms

        "exponential" ->
          factor = normalize_backoff_factor(Map.get(policy, "backoffFactor"))
          round(base_ms * :math.pow(factor, max(attempt - 1, 0)))

        _ ->
          base_ms
      end

    capped_ms =
      case max_ms do
        nil -> base_delay_ms
        value -> min(base_delay_ms, value)
      end

    jitter_bound_ms =
      cond do
        capped_ms <= 0 -> 0
        is_nil(jitter_kind) -> 0
        true -> round(capped_ms * jitter_ratio)
      end

    jitter_ms = deterministic_jitter_ms(seed, jitter_bound_ms)
    applied_ms = max(capped_ms - jitter_ms, 0)

    %{
      "backoffKind" => kind,
      "backoffMs" => applied_ms,
      "backoffBaseMs" => base_delay_ms,
      "backoffCappedMs" => capped_ms,
      "backoffCapMs" => max_ms,
      "backoffJitterKind" => jitter_kind,
      "backoffJitterRatio" => if(is_nil(jitter_kind), do: nil, else: jitter_ratio),
      "backoffJitterMs" => if(is_nil(jitter_kind), do: nil, else: jitter_ms)
    }
  end

  def normalize_max_attempts(value) when is_integer(value) and value > 0, do: value
  def normalize_max_attempts(_value), do: 1

  def normalize_backoff_kind("linear"), do: "linear"
  def normalize_backoff_kind("exponential"), do: "exponential"
  def normalize_backoff_kind(_value), do: "fixed"

  def normalize_backoff_ms(value) when is_integer(value) and value >= 0, do: value
  def normalize_backoff_ms(_value), do: 0

  def normalize_optional_backoff_ms(value) when is_integer(value) and value >= 0, do: value
  def normalize_optional_backoff_ms(_value), do: nil

  def normalize_backoff_factor(value) when is_number(value) and value > 0, do: value
  def normalize_backoff_factor(_value), do: 2.0

  def normalize_backoff_jitter_kind("full"), do: "full"
  def normalize_backoff_jitter_kind("half"), do: "half"
  def normalize_backoff_jitter_kind("ratio"), do: "ratio"
  def normalize_backoff_jitter_kind(_value), do: nil

  def normalize_backoff_jitter_ratio(value, "full") when is_number(value) do
    min(max(value * 1.0, 0.0), 1.0)
  end

  def normalize_backoff_jitter_ratio(_value, "full"), do: 1.0

  def normalize_backoff_jitter_ratio(value, "half") when is_number(value) do
    min(max(value * 1.0, 0.0), 0.5)
  end

  def normalize_backoff_jitter_ratio(_value, "half"), do: 0.5

  def normalize_backoff_jitter_ratio(value, "ratio") when is_number(value) do
    min(max(value * 1.0, 0.0), 1.0)
  end

  def normalize_backoff_jitter_ratio(_value, "ratio"), do: 0.0

  def normalize_backoff_jitter_ratio(_value, _kind), do: nil

  def normalize_retry_family("timeout"), do: "timeout"
  def normalize_retry_family("process_exit"), do: "process_exit"
  def normalize_retry_family("process_spawn"), do: "process_spawn"
  def normalize_retry_family("application"), do: "application"
  def normalize_retry_family(_value), do: "application"

  def normalize_retry_on(values) when is_list(values) do
    normalized =
      values
      |> Enum.filter(&is_binary/1)
      |> Enum.map(fn
        "always" -> "always"
        value -> normalize_retry_family(value)
      end)
      |> Enum.uniq()

    if Enum.member?(normalized, "always") do
      ["always"]
    else
      normalized
    end
  end

  def normalize_retry_on(_values), do: []

  defp retryable_failure?(error_body, retry_on) when is_map(error_body) do
    retryable = Map.get(error_body, "retryable", true) != false
    family = normalize_retry_family(Map.get(error_body, "family"))
    retryable and retry_family_allowed?(family, retry_on)
  end

  defp retryable_failure?(_error_body, retry_on) do
    retry_family_allowed?("application", retry_on)
  end

  defp retry_family_allowed?(_family, []), do: true

  defp retry_family_allowed?(family, retry_on) when is_list(retry_on) do
    normalized = normalize_retry_on(retry_on)
    normalized == [] or "always" in normalized or family in normalized
  end

  defp retry_family_allowed?(_family, _retry_on), do: true

  defp deterministic_jitter_ms(_seed, max_jitter_ms)
       when not is_integer(max_jitter_ms) or max_jitter_ms <= 0,
       do: 0

  defp deterministic_jitter_ms(seed, max_jitter_ms),
    do: :erlang.phash2(seed, max_jitter_ms + 1)
end
