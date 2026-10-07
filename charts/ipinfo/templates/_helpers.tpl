{{- define "ipinfo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "ipinfo.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "ipinfo.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "ipinfo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ipinfo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "ipinfo.labels" -}}
{{ include "ipinfo.selectorLabels" . }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{/* Keep new update settings available when upgrading older releases with --reuse-values. */}}
{{- define "ipinfo.databaseUpdates" -}}
{{- mergeOverwrite (dict "enabled" true "interval" "168h" "proxy" "" "existingConfigMap" "" "proxySecret" (dict "name" "" "key" "proxy") "storageSize" "1Gi" "existingClaim" "") (default (dict) .Values.databaseUpdates) | toJson -}}
{{- end -}}
