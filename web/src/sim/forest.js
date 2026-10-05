// Portable evaluator for the Phase 3 scikit-learn random-forest JSON format.
// Phase 4 can connect these predictions; Phase 3 deliberately leaves engine.js policy unchanged.
export function loadForest(model) {
  if (!model || !Array.isArray(model.trees) || !Array.isArray(model.features)) {
    throw new TypeError('Invalid forest model');
  }
  const featureIndex = new Map(model.features.map((name, index) => [name, index]));
  function treeValue(tree, row) {
    let node = 0;
    while (tree.left[node] !== tree.right[node]) {
      const feature = tree.feature[node];
      if (feature < 0 || feature >= row.length) throw new RangeError(`Invalid feature index ${feature}`);
      node = row[feature] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
    }
    return tree.value[node];
  }
  function vector(input) {
    const values = Array.isArray(input) ? input : model.features.map(name => Number(input[name]));
    return values.map(value => Math.fround(Number(value)));
  }
  function predictProba(input) {
    if (model.kind !== 'classifier') throw new TypeError('predictProba is only available for classifiers');
    const row = vector(input);
    const totals = model.classes.map(() => 0);
    for (const tree of model.trees) {
      const values = treeValue(tree, row);
      const sum = values.reduce((acc, value) => acc + value, 0) || 1;
      for (let i = 0; i < totals.length; i += 1) totals[i] += values[i] / sum;
    }
    const probabilities = {};
    model.classes.forEach((label, i) => { probabilities[label] = totals[i] / model.trees.length; });
    return probabilities;
  }
  function predict(input) {
    const row = vector(input);
    if (model.kind === 'classifier') {
      const probabilities = predictProba(row);
      return model.classes.reduce((best, label) => probabilities[label] > probabilities[best] ? label : best, model.classes[0]);
    }
    if (model.kind !== 'regressor') throw new TypeError(`Unknown forest kind: ${model.kind}`);
    return model.trees.reduce((sum, tree) => sum + treeValue(tree, row)[0], 0) / model.trees.length;
  }
  return { features: [...model.features], featureIndex, predict, ...(model.kind === 'classifier' ? { predictProba } : {}) };
}
