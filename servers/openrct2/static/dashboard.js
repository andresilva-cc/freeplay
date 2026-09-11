(function () {
    var POLL_INTERVAL_MS = 2000;

    function createCard(title) {
        var card = document.createElement("article");
        card.className = "card";

        var body = document.createElement("div");
        body.className = "card-body";

        var heading = document.createElement("div");
        heading.className = "card-heading";

        var titleNode = document.createElement("h2");
        titleNode.className = "card-title";
        titleNode.textContent = title;
        heading.appendChild(titleNode);

        var metaNode = document.createElement("div");
        metaNode.className = "card-meta";
        heading.appendChild(metaNode);

        body.appendChild(heading);
        card.appendChild(body);

        return {
            element: card,
            body: body,
            metaNode: metaNode
        };
    }

    function formatCurrency(value) {
        if (typeof value !== "number" || isNaN(value)) {
            return "n/a";
        }

        return "$" + value.toLocaleString();
    }

    function formatValue(value) {
        if (typeof value === "undefined") {
            return "undefined";
        }

        if (value === null) {
            return "null";
        }

        if (typeof value === "string") {
            return value;
        }

        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }

        return JSON.stringify(value, null, 2);
    }

    function createParkCard() {
        var shell = createCard("Park");
        var grid = document.createElement("div");
        var statsByKey = {};

        function addStat(key, label) {
            var stat = document.createElement("div");
            var labelNode = document.createElement("span");
            var valueNode = document.createElement("span");

            stat.className = "park-stat";
            labelNode.className = "park-stat-label";
            valueNode.className = "park-stat-value";
            labelNode.textContent = label;
            valueNode.textContent = "--";

            stat.appendChild(labelNode);
            stat.appendChild(valueNode);
            grid.appendChild(stat);

            statsByKey[key] = valueNode;
        }

        grid.className = "park-grid";
        addStat("name", "Name");
        addStat("date", "Date");
        addStat("numGuests", "Guests");
        addStat("rating", "Rating");
        addStat("cash", "Cash");
        addStat("bankLoan", "Loan");
        addStat("companyValue", "Company Value");
        addStat("parkValue", "Park Value");
        addStat("entranceFee", "Entrance Fee");
        shell.body.appendChild(grid);

        return {
            element: shell.element,
            update: function (state) {
                if (!state.park) {
                    return;
                }

                shell.metaNode.textContent = state.lastUpdatedText;
                statsByKey.name.textContent = state.park.name || "Unnamed park";
                statsByKey.date.textContent = state.date
                    ? String(state.date.day) + "/" + String(state.date.month) + "/" + String(state.date.year)
                    : "n/a";
                statsByKey.numGuests.textContent = String(state.park.numGuests);
                statsByKey.rating.textContent = String(state.park.rating);
                statsByKey.cash.textContent = formatCurrency(state.park.cash);
                statsByKey.bankLoan.textContent = formatCurrency(state.park.bankLoan);
                statsByKey.companyValue.textContent = formatCurrency(state.park.companyValue);
                statsByKey.parkValue.textContent = formatCurrency(state.park.parkValue);
                statsByKey.entranceFee.textContent = formatCurrency(state.park.entranceFee);
            }
        };
    }

    function createTerminalCard() {
        var shell = createCard("CLI");
        var terminal = document.createElement("div");
        var scroll = document.createElement("div");
        var output = document.createElement("div");
        var form = document.createElement("form");
        var inputRow = document.createElement("div");
        var prompt = document.createElement("span");
        var input = document.createElement("input");
        var history = [];
        var historyMatches = [];
        var historyBaseInput = "";
        var historyIndex = -1;

        shell.element.className += " terminal-card";
        terminal.className = "terminal";
        scroll.className = "terminal-scroll";
        output.className = "terminal-output";
        form.className = "terminal-input-form";
        inputRow.className = "terminal-input-row";
        prompt.className = "terminal-prompt";
        prompt.textContent = "$ ";
        input.className = "terminal-input";
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;

        inputRow.appendChild(prompt);
        inputRow.appendChild(input);
        form.appendChild(inputRow);
        scroll.appendChild(output);
        scroll.appendChild(form);
        terminal.appendChild(scroll);
        shell.body.appendChild(terminal);

        function resetHistoryNavigation() {
            historyMatches = [];
            historyBaseInput = "";
            historyIndex = -1;
        }

        function setInputValue(value) {
            input.value = value;
            input.setSelectionRange(value.length, value.length);
        }

        function scrollToBottom() {
            scroll.scrollTop = scroll.scrollHeight;
        }

        function appendLine(text, className) {
            var line = document.createElement("div");

            line.className = "terminal-line" + (className ? " " + className : "");
            line.textContent = text;
            output.appendChild(line);
            scrollToBottom();
        }

        function buildHistoryMatches(prefix) {
            var matches = [];
            var index;

            for (index = history.length - 1; index >= 0; index--) {
                if (history[index].indexOf(prefix) === 0) {
                    matches.push(history[index]);
                }
            }

            return matches;
        }

        function navigateHistory(direction) {
            if (historyBaseInput !== input.value || historyMatches.length === 0) {
                historyBaseInput = input.value;
                historyMatches = buildHistoryMatches(historyBaseInput);
                historyIndex = -1;
            }

            if (historyMatches.length === 0) {
                return;
            }

            if (direction < 0) {
                if (historyIndex < historyMatches.length - 1) {
                    historyIndex++;
                }
                setInputValue(historyMatches[historyIndex]);
                return;
            }

            if (historyIndex > 0) {
                historyIndex--;
                setInputValue(historyMatches[historyIndex]);
                return;
            }

            historyIndex = -1;
            setInputValue(historyBaseInput);
        }

        form.addEventListener("submit", function (event) {
            var command = input.value;

            event.preventDefault();

            if (!command.trim()) {
                return;
            }

            history.push(command);
            resetHistoryNavigation();
            appendLine("$ " + command, "terminal-line--prompt");
            input.value = "";
            input.disabled = true;

            fetch("/v1/eval?q=" + encodeURIComponent(command))
                .then(function (response) {
                    return response.json();
                })
                .then(function (payload) {
                    if (payload && typeof payload.error !== "undefined") {
                        appendLine(String(payload.error), "terminal-line--error");
                        return;
                    }

                    appendLine(formatValue(payload ? payload.result : undefined));
                })
                .catch(function (error) {
                    appendLine(String(error), "terminal-line--error");
                })
                .finally(function () {
                    input.disabled = false;
                    input.focus();
                    scrollToBottom();
                });
        });

        input.addEventListener("input", function () {
            resetHistoryNavigation();
        });

        input.addEventListener("keydown", function (event) {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                navigateHistory(-1);
                return;
            }

            if (event.key === "ArrowDown") {
                event.preventDefault();
                navigateHistory(1);
                return;
            }

            if (event.ctrlKey && (event.key === "u" || event.key === "U")) {
                event.preventDefault();
                input.value = "";
                resetHistoryNavigation();
                return;
            }

            if (event.ctrlKey && (event.key === "l" || event.key === "L")) {
                event.preventDefault();
                output.innerHTML = "";
            }
        });

        setTimeout(function () {
            input.focus();
        }, 0);

        return {
            element: shell.element,
            update: function (state) {
                shell.metaNode.textContent = state.lastUpdatedText;
            }
        };
    }

    function renderCards(cardFactories) {
        var root = document.getElementById("dashboard-grid");
        var cards = [];
        var index;

        for (index = 0; index < cardFactories.length; index++) {
            cards.push(cardFactories[index]());
            root.appendChild(cards[index].element);
        }

        return cards;
    }

    function loadGameState() {
        return Promise.all([
            fetch("/v1/park").then(function (response) {
                return response.json();
            }),
            fetch("/v1/date").then(function (response) {
                return response.json();
            })
        ]).then(function (results) {
            return {
                park: results[0],
                date: results[1],
                lastUpdatedText: "Updated " + new Date().toLocaleTimeString()
            };
        });
    }

    function refresh(cards) {
        return loadGameState().then(function (state) {
            var index;

            for (index = 0; index < cards.length; index++) {
                cards[index].update(state);
            }
        });
    }

    var cards = renderCards([
        createParkCard,
        createTerminalCard
    ]);

    refresh(cards);
    window.setInterval(function () {
        refresh(cards);
    }, POLL_INTERVAL_MS);
})();
