FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./simulator/requirements.txt
RUN pip install --no-cache-dir -r simulator/requirements.txt

COPY . ./simulator

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "simulator.cli", "--mode", "stream"]
