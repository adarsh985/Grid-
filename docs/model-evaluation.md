# GridSense ML Model Evaluation Report

- **Model Version**: `v1.0.0`
- **Evaluated At**: `2026-11-14T14:35:01.465153Z`
- **Test Split Size**: `11,500` readings (strict time-based holdout: final 20% of 30-day simulation)

## Overall Anomaly Detection Performance

| Metric | Value |
| --- | --- |
| Precision | 0.7624 |
| Recall | 0.9963 |
| F1 Score | 0.8638 |
| False Positive Rate (FPR) | 0.0728 |
| Confusion Matrix (TP / FP / FN / TN) | 2175 / 678 / 8 / 8639 |

## Per-Fault-Type Breakdown

| Fault Type | Support | Precision | Recall (Detection) | F1 Score | False Positive Rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `phase_imbalance` | 359 | 1.0000 | 0.9916 | 0.9958 | 0.0000 |
| `overcurrent_spike` | 182 | 1.0000 | 1.0000 | 1.0000 | 0.0000 |
| `harmonic_distortion` | 252 | 1.0000 | 1.0000 | 1.0000 | 0.0000 |
| `power_theft` | 687 | 0.9927 | 0.9927 | 0.9927 | 0.0005 |
| `voltage_sag` | 335 | 0.9384 | 1.0000 | 0.9682 | 0.0020 |
| `voltage_swell` | 368 | 0.9634 | 1.0000 | 0.9814 | 0.0013 |

## Methodology Notes

- **Models**: Unsupervised Isolation Forest (point anomalies) + PyTorch LSTM Autoencoder (60-step temporal sequences) + Deterministic Hard Rule Layer.
- **Split Strategy**: Strict chronological split (60% train / 20% validation / 20% test) to prevent temporal leakage.
- **Thresholding**: LSTM threshold calibrated at the validation percentile configured in `config.yaml` (`lstm.validation_percentile`) of normal reconstruction errors.
- **Precision vs. Recall Tradeoff**: The ensemble favors high detection sensitivity (`Recall = 0.9963` across all anomalies, catching >99.6% of fault intervals) at the cost of `Precision = 0.7624` (`FPR = 0.0728`), primarily from unsupervised boundary points labeled `anomaly` without a specific fault rule match.
