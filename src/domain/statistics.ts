import { parseNumber } from './dataset'

export interface NumericStatistics {
  count: number
  sum: number
  average: number
  median: number
  min: number
  max: number
}

export function calculateStatistics(values: unknown[]): NumericStatistics | null {
  const numbers = values.map(parseNumber).filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (!numbers.length) return null
  const middle = Math.floor(numbers.length / 2)
  return {
    count: numbers.length,
    sum: numbers.reduce((sum, value) => sum + value, 0),
    average: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    median: numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2,
    min: numbers[0],
    max: numbers[numbers.length - 1],
  }
}

export function percentage(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100
}
