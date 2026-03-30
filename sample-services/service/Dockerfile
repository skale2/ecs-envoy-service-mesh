FROM public.ecr.aws/docker/library/python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py .
ENV APP_PORT=8080
EXPOSE 8080
CMD ["python", "server.py"]
