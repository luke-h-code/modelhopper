clear
clc
close all

results_mat = pull_all_vals_benchmarks(false);

%% ---- Weights ----------------------------------------------------------
financeWeight = 8.0;
codingWeight  = 5.6;
legalWeight   = 1.2;
totalWeight   = financeWeight + codingWeight + legalWeight;

%% ---- Reshape long table -> benchmark x model matrix -------------------
results_mat.Properties.VariableNames(1:5) = {'Case','Rank','Model','Score','Cost'};
results_mat.Case  = string(results_mat.Case);
results_mat.Model = string(results_mat.Model);

%% ---- Cheapest model within a tolerance of a reference model -----------
referenceModel = "anthropic/claude-opus-5";
relativePerformanceTolerancePct = 35;
[BudgetSelections, BudgetCandidates] = select_budget_models(results_mat, referenceModel, ...
    relativePerformanceTolerancePct);
disp(BudgetSelections)
disp(BudgetCandidates)

%% ---- Per-benchmark score/cost Pareto plots ----------------------------
makeParetoFigures = true;
if makeParetoFigures
    plot_benchmark_pareto_figures(results_mat);
end

cases  = unique(results_mat.Case,  'stable');
models = unique(results_mat.Model, 'stable');

% Build nCase x nModel score matrix by index (no table column names involved)
M = nan(numel(cases), numel(models));
[~, ci] = ismember(results_mat.Case,  cases);
[~, mi] = ismember(results_mat.Model, models);
M(sub2ind(size(M), ci, mi)) = results_mat.Score;

%% ---- Component benchmark groups ---------------------------------------
financeCases = ["fabv2"; "emb"];
legalCases   = ["legal_research"; "hlab"];
codingCases  = ["terminal-bench-2-1"; "code-migration"; "vibe-code"];

fRows = ismember(cases, financeCases);
lRows = ismember(cases, legalCases);
cRows = ismember(cases, codingCases);

%% ---- Per-model composite ----------------------------------------------
finance = mean(M(fRows, :), 1);
legal   = mean(M(lRows, :), 1);
coding  = mean(M(cRows, :), 1);

composite = (financeWeight*finance + codingWeight*coding + legalWeight*legal) / totalWeight;

%% ---- Hypothetical: best model per case, then aggregated ----------------
best = max(M, [], 2, 'omitnan');                               % best score per case

financeBest = mean(best(fRows));
legalBest   = mean(best(lRows));
codingBest  = mean(best(cRows));

compositeBest = (financeWeight*financeBest + codingWeight*codingBest + legalWeight*legalBest) / totalWeight;

%% ---- Scenarios: one bar chart each ------------------------------------
excludeFable     = contains(models, "fable",        'IgnoreCase', true);
excludeAnthropic = startsWith(models, "anthropic/", 'IgnoreCase', true);

% For final scenario, exclude everything except these model families
keepSelected = any(contains(models, ...
    ["kimi","deepseek","glm","qwen","minimax"], 'IgnoreCase', true), 2);
excludeNonSelected = ~keepSelected;

scenarioNames = ["All models available"; ...
                 "No Fable"; ...
                 "No Anthropic"; ...
                 "Kimi, DeepSeek, GLM, Qwen & MiniMax only"];

scenarioMasks = {false(size(models)), ...
                 excludeFable, ...
                 excludeAnthropic, ...
                 excludeNonSelected};

for s = 1:numel(scenarioNames)
    drop = scenarioMasks{s};

    % Best-of-each recomputed using only models allowed in this scenario
    Ms = M;
    Ms(:, drop) = NaN;

    bestS = max(Ms, [], 2, 'omitnan');

    bestComposite = ( financeWeight*mean(bestS(fRows)) ...
                    + codingWeight *mean(bestS(cRows)) ...
                    + legalWeight  *mean(bestS(lRows)) ) / totalWeight;

    % ALL models stay on every chart
    hypoLabel = "Best-of-each (hypothetical)";
    labels = [models; hypoLabel];
    vals   = [composite.'; bestComposite];

    valid  = ~isnan(vals);
    labels = labels(valid);
    vals   = vals(valid);

    [vals, ord] = sort(vals, 'descend');
    labels = labels(ord);

    figure('Color','w');
    hb = bar(vals, 'FaceColor','flat');
    hb.CData = repmat([0.30 0.50 0.90], numel(vals), 1);
    hb.CData(labels == hypoLabel, :) = [0.90 0.40 0.20];

    set(gca, 'XTick', 1:numel(vals), ...
             'XTickLabel', labels, ...
             'XTickLabelRotation', 40);

    ylabel('Weighted composite score');
    title(sprintf('Composite score by model — %s', scenarioNames(s)));
    grid on;

    text(1:numel(vals), vals, compose('%.2f', vals), ...
         'HorizontalAlignment','center', ...
         'VerticalAlignment','bottom');
end

function [masterTable, scoreMatrix, costMatrix] = pull_all_vals_benchmarks(saveToFile)
% PULL_ALL_VALS_BENCHMARKS Discovers and pulls all available benchmark results from vals.ai
%
% Usage:
%   T = pull_all_vals_benchmarks;                     % Long table with Score (%) and Cost ($)
%   [T, S, C] = pull_all_vals_benchmarks;             % T: long table, S: score matrix, C: cost matrix
%   [T, S, C] = pull_all_vals_benchmarks(true);       % Also saves to vals_all_benchmarks.mat
%
% Outputs:
%   masterTable : Table [Benchmark, Rank, Model, Score_Pct, Cost_USD, Description]
%   scoreMatrix : Wide table with Model as rows and each Benchmark score (%) as columns
%   costMatrix  : Wide table with Model as rows and each Benchmark cost ($) as columns

    if nargin < 1
        saveToFile = false;
    end

    opts = weboptions('ContentType', 'text', 'UserAgent', 'Mozilla/5.0');

    % 1. Discover all benchmark slugs from https://www.vals.ai/benchmarks
    fprintf('Discovering benchmarks from vals.ai/benchmarks ...\n');
    try
        indexHtml = webread('https://www.vals.ai/benchmarks', opts);
    catch err
        error('Failed to access vals.ai/benchmarks: %s', err.message);
    end

    rawMatches = regexp(indexHtml, 'href="/benchmarks/([a-zA-Z0-9_\-]+)"', 'tokens');
    slugs = {};
    for i = 1:length(rawMatches)
        s = rawMatches{i}{1};
        if ~ismember(s, slugs) && ~strcmp(s, 'benchmarks')
            slugs{end+1} = s; %#ok<AGROW>
        end
    end

    totalBenchmarks = length(slugs);
    fprintf('Found %d benchmarks. Starting download...\n\n', totalBenchmarks);

    % 2. Loop through and pull each benchmark
    allRows = {};
    for i = 1:totalBenchmarks
        slug = slugs{i};
        fprintf('[%2d/%2d] Pulling %-25s ... ', i, totalBenchmarks, slug);
        
        try
            url = sprintf('https://www.vals.ai/benchmarks/%s', slug);
            html = webread(url, opts);

            % Extract props from BenchmarkView island
            tok = regexp(html, 'component-url="[^"]*BenchmarkView[^"]*"[^>]*props="([^"]+)"', 'tokens', 'once');
            if isempty(tok)
                tok = regexp(html, 'props="([^"]+)"[^>]*component-url="[^"]*BenchmarkView[^"]*"', 'tokens', 'once');
            end
            if isempty(tok)
                fprintf('Skipped (custom layout / non-matrix view)\n');
                continue;
            end

            jsonStr = strrep(tok{1}, '&quot;', '"');
            benchmarkDescription = extract_benchmark_description(jsonStr);
            idx = strfind(jsonStr, '"overall":[0,{');
            if isempty(idx)
                fprintf('Skipped (no "overall" task)\n');
                continue;
            end

            sub = jsonStr(idx(1):end);
            braceIdx = strfind(sub, '{');
            depth = 1; pos = braceIdx(1) + 1;
            while pos <= length(sub) && depth > 0
                if sub(pos) == '{', depth = depth + 1;
                elseif sub(pos) == '}', depth = depth - 1; end
                pos = pos + 1;
            end
            overallBlock = sub(braceIdx(1):pos-1);

            % Find model entries that are direct children of "overall".
            % Model records can contain nested objects (for example usage and
            % outcome details), so a [^{}]* regex cannot safely capture them.
            entryPattern = '"([a-zA-Z0-9_\-/\.]+)":\[0,\{';
            [entryStarts, entryEnds, entryTokens] = regexp(overallBlock, ...
                entryPattern, 'start', 'end', 'tokens');

            if isempty(entryTokens)
                fprintf('Skipped (no model entries found)\n');
                continue;
            end

            % Extract scores and costs for genuine model entries
            validModels = {};
            validScores = [];
            validCosts = [];
            numberPattern = '([-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)';
            scanPos = 1;
            scanDepth = 0;
            inString = false;
            escaped = false;

            for k = 1:length(entryTokens)
                % Determine the JSON object depth at the candidate key. Only
                % depth 1 belongs directly to the overall results object.
                while scanPos < entryStarts(k)
                    ch = overallBlock(scanPos);
                    if inString
                        if escaped
                            escaped = false;
                        elseif ch == '\'
                            escaped = true;
                        elseif ch == '"'
                            inString = false;
                        end
                    elseif ch == '"'
                        inString = true;
                    elseif ch == '{'
                        scanDepth = scanDepth + 1;
                    elseif ch == '}'
                        scanDepth = scanDepth - 1;
                    end
                    scanPos = scanPos + 1;
                end

                mName = entryTokens{k}{1};
                if scanDepth ~= 1 || ~contains(mName, '/')
                    continue;
                end

                % entryEnds(k) is the opening brace of this model's value.
                closeBrace = find_matching_json_brace(overallBlock, entryEnds(k));
                if isempty(closeBrace)
                    continue;
                end
                body = overallBlock(entryEnds(k)+1:closeBrace-1);

                accTok = regexp(body, ...
                    ['"accuracy":\[0,' numberPattern '\]'], 'tokens', 'once');
                if isempty(accTok)
                    continue;
                end

                cVal = NaN;
                costTok = regexp(body, ...
                    ['"cost_per_test":\[0,' numberPattern '\]'], 'tokens', 'once');
                if ~isempty(costTok), cVal = str2double(costTok{1}); end
                validModels{end+1} = mName; %#ok<AGROW>
                validScores(end+1) = str2double(accTok{1}); %#ok<AGROW>
                validCosts(end+1) = cVal; %#ok<AGROW>
            end

            N = length(validModels);
            if N == 0
                fprintf('Skipped (no valid models found)\n');
                continue;
            end

            % Sort models descending by score
            [sortedScores, order] = sort(validScores, 'descend');
            sortedModels = validModels(order);
            sortedCosts = validCosts(order);

            for k = 1:N
                allRows(end+1, :) = {string(slug), k, string(sortedModels{k}), ...
                    sortedScores(k), sortedCosts(k), benchmarkDescription}; %#ok<AGROW>
            end

            topCostStr = '';
            if ~isnan(sortedCosts(1))
                topCostStr = sprintf(', $%.2f', sortedCosts(1));
            end
            fprintf('OK (%2d models, top: %s = %.1f%%%s)\n', N, sortedModels{1}, sortedScores(1), topCostStr);

        catch err
            fprintf('Error (%s)\n', err.message);
        end
    end

    if isempty(allRows)
        error('Failed to pull any benchmark data.');
    end

    % 3. Build master long-format table
    masterTable = cell2table(allRows, 'VariableNames', ...
        {'Benchmark', 'Rank', 'Model', 'Score_Pct', 'Cost_USD', 'Description'});

    % 4. Build wide-format Model x Benchmark matrices
    uniqueEntries = unique(masterTable(:, {'Model', 'Benchmark'}), 'rows');
    scores = NaN(height(uniqueEntries), 1);
    costs = NaN(height(uniqueEntries), 1);
    for j = 1:height(uniqueEntries)
        matchIdx = find(masterTable.Model == uniqueEntries.Model(j) & ...
                        masterTable.Benchmark == uniqueEntries.Benchmark(j), 1);
        if ~isempty(matchIdx)
            scores(j) = masterTable.Score_Pct(matchIdx);
            costs(j) = masterTable.Cost_USD(matchIdx);
        end
    end

    compactScores = table(uniqueEntries.Model, uniqueEntries.Benchmark, scores, ...
        'VariableNames', {'Model', 'Benchmark', 'Score_Pct'});
    compactCosts = table(uniqueEntries.Model, uniqueEntries.Benchmark, costs, ...
        'VariableNames', {'Model', 'Benchmark', 'Cost_USD'});

    try
        scoreMatrix = unstack(compactScores, 'Score_Pct', 'Benchmark', 'VariableNamingRule', 'preserve');
    catch
        scoreMatrix = table();
    end

    try
        costMatrix = unstack(compactCosts, 'Cost_USD', 'Benchmark', 'VariableNamingRule', 'preserve');
    catch
        costMatrix = table();
    end

    % 5. Save to .mat file if requested
    if saveToFile
        outMat = 'vals_all_benchmarks.mat';
        save(outMat, 'masterTable', 'scoreMatrix', 'costMatrix');
        fprintf('\nSaved results to %s\n', fullfile(pwd, outMat));
    end

    % 6. Print summary
    uniqueModels = length(unique(masterTable.Model));
    uniqueBenches = length(unique(masterTable.Benchmark));
    fprintf('\n=========================================\n');
    fprintf('  Total Data Points : %d\n', height(masterTable));
    fprintf('  Unique Benchmarks : %d\n', uniqueBenches);
    fprintf('  Unique Models     : %d\n', uniqueModels);
    fprintf('=========================================\n\n');
end

function description = extract_benchmark_description(jsonStr)
% Read the benchmark description from the decoded Astro/devalue props.
    description = "";
    try
        props = jsondecode(jsonStr);
        benchmarkView = unwrap_devalue(props.benchmarkView);
        if isfield(benchmarkView, 'default')
            benchmarkData = unwrap_devalue(benchmarkView.default);
        else
            benchmarkData = benchmarkView;
        end
        metadata = unwrap_devalue(benchmarkData.metadata);
        description = string(unwrap_devalue(metadata.description));

        % jsondecode handles JSON escaping, but HTML character references
        % inside string values remain encoded.
        description = replace(description, ...
            ["&#39;", "&#x27;", "&apos;", "&amp;", "&lt;", "&gt;", "&nbsp;", "&mdash;", "&ndash;"], ...
            ["'",     "'",      "'",      "&",     "<",    ">",    " ",      "—",       "–"]);
    catch
        % Description metadata is optional and should never prevent scores
        % from being downloaded.
        description = "";
    end
end

function value = unwrap_devalue(value)
% Astro serializes values as {type marker, value}; return the value member.
    if iscell(value) && numel(value) >= 2
        value = value{2};
    end
end

function [selections, candidates] = select_budget_models(resultsTable, referenceModel, tolerancePct)
% For benchmarks containing referenceModel, find the cheapest cheaper model
% within tolerancePct of its score. Also return every qualifying candidate
% so the selected model can be audited against the full eligible set.
    benchmarkNames = unique(resultsTable.Case, 'stable');
    rows = cell(0, 14);
    candidateRows = cell(0, 13);

    for i = 1:numel(benchmarkNames)
        benchmarkName = benchmarkNames(i);
        sub = resultsTable(resultsTable.Case == benchmarkName, :);
        referenceRows = sub(sub.Model == referenceModel, :);

        % Omit benchmarks on which the reference model does not appear.
        if isempty(referenceRows)
            continue;
        end

        description = "";
        if ismember('Description', sub.Properties.VariableNames) && ~isempty(sub)
            description = sub.Description(1);
        end

        referenceScore = NaN;
        referenceCost = NaN;
        selectedModel = string(missing);
        selectedScore = NaN;
        selectedCost = NaN;
        relativeLossPct = NaN;
        costSaving = NaN;
        costSavingPct = NaN;
        found = false;
        status = "A qualifying cheaper model couldn't be found";

        validReference = referenceRows(isfinite(referenceRows.Score), :);
        if isempty(validReference)
            status = "Opus 5 has no valid score";
        else
            % Duplicate rows are not expected, but prefer the highest score
            % and then the cheapest cost if they occur.
            validReference = sortrows(validReference, ...
                {'Score', 'Cost'}, {'descend', 'ascend'}, ...
                'MissingPlacement', 'last');
            referenceScore = validReference.Score(1);
            referenceCost = validReference.Cost(1);

            if ~isfinite(referenceCost)
                status = "Opus 5 has no valid cost";
            else
                minimumScore = referenceScore * (1 - tolerancePct / 100);
                qualifies = isfinite(sub.Score) & isfinite(sub.Cost) & ...
                    sub.Model ~= referenceModel & ...
                    sub.Score >= minimumScore & sub.Cost < referenceCost;
                alternatives = sub(qualifies, :);

                if ~isempty(alternatives)
                    % Cheapest wins; score breaks equal-cost ties.
                    alternatives = sortrows(alternatives, ...
                        {'Cost', 'Score', 'Model'}, {'ascend', 'descend', 'ascend'});

                    % Retain every qualifying model for inspection. The
                    % first row is the actual cheapest-model selection.
                    for j = 1:height(alternatives)
                        candidateLossPct = ...
                            (referenceScore - alternatives.Score(j)) / referenceScore * 100;
                        candidateSaving = referenceCost - alternatives.Cost(j);
                        if referenceCost ~= 0
                            candidateSavingPct = candidateSaving / referenceCost * 100;
                        else
                            candidateSavingPct = NaN;
                        end
                        candidateRows(end+1, :) = {benchmarkName, description, ...
                            tolerancePct, referenceModel, referenceScore, referenceCost, ...
                            alternatives.Model(j), alternatives.Score(j), alternatives.Cost(j), ...
                            candidateLossPct, candidateSaving, candidateSavingPct, j == 1}; %#ok<AGROW>
                    end

                    selectedModel = alternatives.Model(1);
                    selectedScore = alternatives.Score(1);
                    selectedCost = alternatives.Cost(1);
                    relativeLossPct = ...
                        (referenceScore - selectedScore) / referenceScore * 100;
                    costSaving = referenceCost - selectedCost;
                    if referenceCost ~= 0
                        costSavingPct = costSaving / referenceCost * 100;
                    end
                    found = true;
                    status = "Found";
                end
            end
        end

        rows(end+1, :) = {benchmarkName, description, tolerancePct, ...
            referenceModel, referenceScore, referenceCost, ...
            selectedModel, selectedScore, selectedCost, relativeLossPct, ...
            costSaving, costSavingPct, found, status}; %#ok<AGROW>
    end

    selections = cell2table(rows, 'VariableNames', ...
        {'Benchmark', 'Description', 'TolerancePct', ...
         'ReferenceModel', 'OpusScore', 'OpusCost', ...
         'SelectedModel', 'SelectedScore', 'SelectedCost', ...
         'RelativePerformanceLossPct', 'CostSavingUSD', 'CostSavingPct', ...
         'Found', 'Status'});

    candidates = cell2table(candidateRows, 'VariableNames', ...
        {'Benchmark', 'Description', 'TolerancePct', ...
         'ReferenceModel', 'OpusScore', 'OpusCost', ...
         'CandidateModel', 'CandidateScore', 'CandidateCost', ...
         'RelativePerformanceLossPct', 'CostSavingUSD', 'CostSavingPct', ...
         'IsSelected'});
end

function plot_benchmark_pareto_figures(resultsTable)
% Create one score-versus-cost Pareto plot for each benchmark.
    benchmarkNames = unique(resultsTable.Case, 'stable');

    for i = 1:numel(benchmarkNames)
        benchmarkName = benchmarkNames(i);
        sub = resultsTable(resultsTable.Case == benchmarkName, :);
        valid = isfinite(sub.Score) & isfinite(sub.Cost);
        sub = sub(valid, :);

        if isempty(sub)
            warning('No finite score/cost pairs for benchmark "%s".', benchmarkName);
            continue;
        end

        % A point is dominated when another model is at least as accurate
        % and no more expensive, with a strict improvement on either axis.
        isPareto = true(height(sub), 1);
        for j = 1:height(sub)
            noWorse = sub.Cost <= sub.Cost(j) & sub.Score >= sub.Score(j);
            strictlyBetter = sub.Cost < sub.Cost(j) | sub.Score > sub.Score(j);
            isPareto(j) = ~any(noWorse & strictlyBetter);
        end

        frontier = sub(isPareto, :);
        frontier = sortrows(frontier, {'Cost', 'Score'}, {'ascend', 'ascend'});
        other = sub(~isPareto, :);

        fig = figure('Color', 'w', ...
            'Name', sprintf('Pareto - %s', benchmarkName), ...
            'NumberTitle', 'off');
        ax = axes(fig);
        hold(ax, 'on');

        legendHandles = gobjects(0, 1);
        legendLabels = strings(0, 1);

        if ~isempty(other)
            h = scatter(ax, other.Cost, other.Score, 34, ...
                [0.72 0.72 0.72], 'filled', ...
                'MarkerFaceAlpha', 0.65, 'MarkerEdgeColor', [0.45 0.45 0.45]);
            legendHandles(end+1, 1) = h; %#ok<AGROW>
            legendLabels(end+1, 1) = "Non-Pareto models"; %#ok<AGROW>
        end

        if height(frontier) > 1
            h = plot(ax, frontier.Cost, frontier.Score, '-', ...
                'Color', [0.15 0.15 0.15], 'LineWidth', 1.4);
            legendHandles(end+1, 1) = h; %#ok<AGROW>
            legendLabels(end+1, 1) = "Pareto frontier"; %#ok<AGROW>
        end

        colors = lines(height(frontier));
        for j = 1:height(frontier)
            h = scatter(ax, frontier.Cost(j), frontier.Score(j), 64, ...
                colors(j, :), 'filled', 'MarkerEdgeColor', 'k', ...
                'LineWidth', 0.6);
            legendHandles(end+1, 1) = h; %#ok<AGROW>
            legendLabels(end+1, 1) = frontier.Model(j); %#ok<AGROW>
        end

        xlabel(ax, 'Cost per test (USD)');
        ylabel(ax, 'Score (%)');
        title(ax, sprintf('%s: score vs. cost', benchmarkName), ...
            'Interpreter', 'none');
        if ismember('Description', sub.Properties.VariableNames)
            description = sub.Description(1);
            if strlength(description) > 0
                subtitle(ax, description, 'Interpreter', 'none');
            end
        end
        grid(ax, 'on');
        box(ax, 'on');
        legend(ax, legendHandles, legendLabels, ...
            'Location', 'eastoutside', 'Interpreter', 'none');
        hold(ax, 'off');
    end
end

function closeBrace = find_matching_json_brace(text, openBrace)
% Return the closing brace paired with openBrace, ignoring braces in strings.
    closeBrace = [];
    depth = 1;
    inString = false;
    escaped = false;

    for pos = openBrace + 1:length(text)
        ch = text(pos);
        if inString
            if escaped
                escaped = false;
            elseif ch == '\'
                escaped = true;
            elseif ch == '"'
                inString = false;
            end
        elseif ch == '"'
            inString = true;
        elseif ch == '{'
            depth = depth + 1;
        elseif ch == '}'
            depth = depth - 1;
            if depth == 0
                closeBrace = pos;
                return;
            end
        end
    end
end
