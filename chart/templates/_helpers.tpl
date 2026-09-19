{{- define "nodejs-hello-world.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nodejs-hello-world.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "nodejs-hello-world.selectorLabels" -}}
app: {{ include "nodejs-hello-world.fullname" . }}
{{- end -}}

{{- define "nodejs-hello-world.labels" -}}
{{ include "nodejs-hello-world.selectorLabels" . }}
{{- end -}}
